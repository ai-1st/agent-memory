# Changelog — opinionated memory service

The design story, newest first. Each entry: what changed, why, what I observed.

---

## v6 — Make `reason` earn its keep (CoT + narrated contradictions)

**What changed:** The per-op `reason` field in the reconcile schema used to sit
*last* and was essentially vestigial — it was emitted after the decision (so it
couldn't influence it), stored only as the note on contradiction links, and never
read back. Two changes fixed that:
1. **`reason` moved to the FIRST field** of the reconcile op (`schemas.ts`), so the
   model writes its justification before choosing `op`/`value` — real
   chain-of-thought that conditions the decision instead of a post-hoc label. The
   reconcile prompt now instructs "reason first".
2. **The contradiction link note is surfaced in recall.** Previously recall
   annotated conflicts as `[CONTRADICTS id=…]` (opaque ids); now it injects the
   conflicting fact's value *and* the stored reason, e.g. `[CONTRADICTS "User
   previously liked oranges" — oranges now too acidic]`, and the compaction prompt
   narrates the change **and the why** ("…now prefers apples — finds oranges too
   acidic") rather than just *that* a change happened.

**Why:** an LLM "reason" only improves a decision if it precedes it; and a stored
note that nothing reads is wasted output tokens. This turns the field from dead
weight into (a) a quality lever on the reconcile decision and (b) the
contradiction *narration* the design always intended.

**Observed:** offline suite green; recall now explains the cause of a reversal, not
just its existence.

---

## v5 — Live wiring against Claude Opus 4.8 (the `temperature` trap)

**What changed:** Ran the first real end-to-end smoke (real Anthropic + OpenAI
keys) on host port 8091. Hit a hard 400 from the API: ``temperature is
deprecated for this model``. Root cause: `claude-opus-4-8` rejects the
`temperature` sampling parameter, but Vercel AI SDK v4's core injects
`temperature: 0` by default (a documented v4 behavior, slated for removal in v5)
even when you don't set it. The installed `@ai-sdk/anthropic` (1.2.12) only
strips temperature when the *old* budget-style `thinking` block is enabled —
which this model also rejects — so neither knob alone fixes it.

**Why this approach:** Rather than pin SDK versions or fight the default, I strip
`temperature` at the `fetch` boundary of the Anthropic provider. It's
version-robust (works regardless of how the SDK constructs the body) and isolated
to one place. Determinism is steered by the prompts + structured-output schemas
instead.

**Result:** Live smoke fully green. Real extraction produced exactly the
context-enriched, self-contained facts the design targets, e.g.:
- `[fact] location = "User lives in Berlin"` + `event:moved_to_berlin = "User
  moved to Berlin from NYC in early February 2025"`
- `[fact] pet:biscuit = "User has a pet (likely a dog) named Biscuit"` (implicit,
  from "walking Biscuit")
- The **contradiction**: `preference:fruit = "User currently prefers apples over
  oranges"` with a two-way `CONTRADICTS` link to "User really likes oranges", and
  recall narrated: *"User previously really liked oranges but now prefers apples,
  and finds oranges too acidic now."*
- Multi-hop "what city does the user with the dog named Biscuit live in?" →
  Berlin + Biscuit. Noise probe (favourite programming language) → empty.

**Observed wart:** the live model sometimes emits two rows for one concept with
different `type` (a `preference` and an `opinion` both keyed
`preference:oranges`). Linking still works; logged as mild over-extraction in the
README rather than chased down.

---

## v4 — Offline determinism: mock provider + the noise/morphology fixes

**What changed:** Built the deterministic mock LLM provider so the entire
pipeline runs offline in CI, and got the fixture suite to green.

**Why:** The contract tests must run with no network/keys, and I wanted a tight
iteration loop. The mock is a transparent rule engine that emits the *same*
Zod-typed objects the live model would, exercising every real code path (parallel
reconcile, link creation, link-following recall, budget guard, citations).

**What I observed (and fixed), running `quality.test.ts` after each change:**
- *8/9 → contradiction miss.* The full-sentence case ("I really like oranges" →
  "These days I prefer apples, oranges feel too acidic now") wasn't linking,
  because apples/oranges share no token, so my "same topic, opposite sentiment"
  rule never fired. Fix: marker-driven contradiction — a reversal word
  (`prefer/now/instead/used to`) plus a tiny domain lexicon (oranges and apples
  are both `fruit`) triggers `CONTRADICT`.
- *Noise resistance failing.* "favourite programming language" returned a generic
  profile instead of empty. Fix: a noise gate — if the query has real tokens but
  nothing (lexical overlap, semantic similarity, or a contradiction link) is
  relevant, return empty context.
- *Allergy recall then broke under the noise gate.* "food allergies" vs "allergic
  to shellfish" share no exact token, so the gate wrongly fired. Fix: a crude
  suffix stemmer in the mock's tokenizer ("allergies"→"allerg",
  "allergic"→"allerg") plus surfacing the real pgvector similarity score into the
  candidate block so the gate can use semantic relevance, not just lexical.

**Result:** **9/9** fixture probes pass offline; **19/19** tests green;
`tsc`/`biome` clean. (These mock fixes are scoped to the mock — the live model
handles morphology and topic relatedness natively; v5 confirmed it does better.)

---

## v3 — Contradictions are linked, not deleted

**What changed:** Replaced "new value always supersedes old" with a 5-way
reconciliation decision: `ADD | UPDATE | REINFORCE | CONTRADICT | NOOP`, and added
a `memory_links` table with two-way `contradiction` edges. Recall now always
follows those links (full chain) and the LLM narrates the tension.

**Why:** A pure supersession model throws away the most interesting signal — that
the user *changed their mind*. "Liked oranges → prefers apples" should read as a
reversal in recall, not silently drop the old preference. Neutral progression of
a single-valued fact (moved cities) still uses plain `UPDATE`/supersede; reversals
of preferences/opinions use `CONTRADICT` and keep both rows active.

**Result:** This became the headline opinion of the submission. `/users/:id/
memories` exposes the link graph as a `contradicts[]` array per memory; recall
pulls the partner even when the query only matches one side (covered by a test).

**Tradeoff noted:** more active rows, and the reconciler must tolerate the
occasional duplicate — accepted for the recall-narration payoff.

---

## v2 — Synchronous, per-fact, parallel reconciliation

**What changed:** Made `POST /turns` fully synchronous with the
extract → (per-fact: embed + semantic-search + reconcile) → apply pipeline. The
heavy LLM/embedding work fans out with `Promise.all`; cheap writes apply serially
to avoid two facts in one turn racing on the same slot. Raw turn is persisted
*first*, before extraction, so a citable record always survives.

**Why:** The brief gives `/turns` a 60 s budget and says not to waste effort on
async orchestration. Doing all the work up front makes the contract's hardest
guarantee — immediate queryability, no eventual-consistency gap — true by
construction, and removes a whole class of race conditions. Per-fact (rather than
whole-turn) reconciliation lets each fact see only its real semantic neighbours,
which makes the LLM's ADD/UPDATE/CONTRADICT decision far more reliable.

**Result:** Reads-after-writes are correct with zero extra machinery; restart
persistence works because pglite commits are awaited before `201`.

---

## v1 — Store, contract, and the LLM seam

**What changed:** Stood up the Hono app implementing the seven contract
endpoints with shapes identical to the root baseline, on pglite + the `vector`
extension (relational facts, raw turns, embeddings, link graph in one embedded
Postgres on a Docker volume). Defined the single injectable `LLMProvider` seam
(live = Vercel AI SDK; mock = offline) and the Zod schemas for every structured
decision.

**Why:** Contract parity first, and an injectable model layer so everything can
be tested offline. pglite chosen for real durability with zero external services
and one consistency model across rows, vectors, and the link graph (vs. an
external vector DB or a graph engine, both unjustified at this scope).

**Result:** Health/roundtrip/persistence working end to end against the mock;
foundation for v2–v5.
