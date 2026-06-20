# Memory Service — the "simple" variant

> **Design philosophy: a maintainer groks it in five minutes.** Minimal moving
> parts, a linear pipeline, and an inspectable store. Where there's a choice
> between clever and obvious, this variant picks obvious — even when it costs a
> little recall quality. That's the point of the variant.

This is one of three explorations of the memory-service contract. It implements
the full HTTP contract (`/health`, `/turns`, `/recall`, `/search`,
`/users/:id/memories`, `DELETE /sessions/:id`, `DELETE /users/:id`) over an
embedded Postgres store, with one structured LLM extraction pass per turn and a
clear hybrid (semantic + keyword) recall.

---

## 1. Architecture

```
                              POST /turns
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  app.ts  (Hono)            one LINEAR ingestion pipeline       │
   │                                                               │
   │  1. persist turn  ─────────────────────────────┐             │
   │  2. embed(turn text)        provider.embed()    │  store.ts   │
   │  3. extract memories        provider.extract()  │  (pglite +  │
   │  4. embed each memory       provider.embed()    │   vector)   │
   │  5. upsert w/ supersession  store.addMemory() ──┘             │
   └─────────────────────────────────────────────────────────────┘
                                  │  (synchronous: committed before 201)
        ┌─────────────────────────┴──────────────────────────┐
        ▼                                                      ▼
   POST /recall                                          POST /search
   recall.ts                                             store.search()
   ┌───────────────────────────────────┐                structured rows:
   │ semantic (cosine) + keyword overlap│                content/score/
   │  → fused score (α=0.6)             │                session/ts/meta
   │ budget-bounded assembly:           │
   │  (a) stable facts  (always-on)     │   GET /users/:id/memories
   │  (b) query-relevant + recent       │   → clean typed rows w/ provenance,
   │ optional LLM compaction            │     confidence, supersedes, active
   └───────────────────────────────────┘
```

**Two seams, deliberately:**

- **`store.ts`** — pglite (embedded Postgres) + the `vector` extension. One file,
  two tables (`turns`, `memories`). All fact-evolution logic lives in one
  method (`addMemory`).
- **`provider.ts`** — the *only* place we talk to the outside world: LLM
  extraction, embeddings, optional compaction. Swap `LiveProvider` (Claude Opus
  4.8 + OpenAI `text-embedding-3-large`) for `MockProvider` (deterministic,
  offline) and the whole test suite runs without a network.

Everything else (`recall.ts`, `app.ts`, `text.ts`, `tokens.ts`) is plain,
dependency-light TypeScript you can read top to bottom.

---

## 2. Backing store choice — pglite + `vector`

**pglite** (`@electric-sql/pglite`) is real Postgres compiled to WASM, running
embedded in the Node process and persisting to a single directory. With the
`vector` extension it gives us:

- a `vector(3072)` column with cosine distance for **semantic search**, AND
- ordinary SQL, indexes, JSONB, and transactions for **everything else**,

…in **one embedded process with no external database container**. `docker
compose up` is genuinely the only setup step — there is no Postgres/Qdrant
sidecar to wait on.

It also gives us **synchronous correctness for free**: every write is committed
inside the request handler before we return `201`, so a `/recall` issued
immediately after `/turns` always sees the new memories. No eventual-consistency
gap, no background indexer to race.

Why not SQLite+FTS (the baseline) or a dedicated vector DB? SQLite has no native
vector type; a dedicated vector DB is another service to run and reason about.
pglite is the smallest thing that gives us first-class vectors *and* SQL in one
file — which is exactly the "minimal moving parts" the brief asks for.

Persistence is the `MEMORY_DATA_DIR` directory, mounted on a named Docker volume,
so it survives `docker compose down && up`.

---

## 3. Extraction pipeline — structured memories, not message chunks

One structured LLM pass per turn (`provider.extract`), then a simple upsert.

- **Live path** (`LiveProvider`): Claude **Opus 4.8** via the Vercel AI SDK's
  `generateObject` + a Zod schema. The model reads the turn's transcript and
  returns a typed list of memories. Each memory has a `type`
  (`fact`/`preference`/`opinion`/`event`), a **canonical `key`** (the slot —
  `employment`, `location`, `pet:biscuit`, `allergy:shellfish`,
  `preference:typescript`), a human-readable `value`, a `confidence`, and a
  `mutable` flag (single-valued slot vs additive). We carry a `snippet` of the
  source for provenance.
- **Offline path** (`MockProvider`): a small, deterministic regex extractor that
  recognises the same categories. It exists so CI and local dev run with **no
  API keys and no flakiness** — it is *not* the product extractor, just a
  faithful stand-in that exercises the real pipeline.

The prompt instructs the model to capture exactly what the spec calls out:
explicit facts, **implicit facts** ("walking Biscuit this morning" → has a pet
named Biscuit), and **corrections** ("actually I meant Berlin"). It records facts
about the *user only* (assistant/world text is a precision trap).

**What we extract:** employment, location/moves, name, family, pets (incl.
implicit), diet, allergies, preferences, opinions, dated events.

**What we miss, and why:** the regex offline extractor only covers first-person
templated phrasings — paraphrases and oblique statements slip through (the live
LLM extractor catches far more). We deliberately lean **precision over recall**:
a missed fact is recoverable next turn or via `/search` over the raw turn text;
a *wrong* fact pollutes every future recall. We do not do multi-pass reconcile
loops or entity-graph construction — that's the "maxxed" variant's job.

`GET /users/:id/memories` returns these rows verbatim — typed, with provenance
(`source_turn`, `source_session`), `confidence`, the `supersedes` chain, and
`active`. It is a clean audit trail, not message blobs.

---

## 4. Recall strategy — clear hybrid + budget-bounded assembly

End-to-end (`recall.ts`), and it's short enough to read in full:

1. **Embed the query** once, fetch all active memories for the user, and score
   each with a **fixed-weight fusion**:

   ```
   score = α · semantic + (1-α) · keyword     (α = 0.6)
   ```

   - `semantic` = cosine similarity from the pglite `vector` column — handles
     paraphrase ("where do they live" ↔ "moved to Berlin").
   - `keyword` = `|query ∩ text| / |query|` — rescues exact-token queries that
     embeddings fumble ("what's the **dog**'s **name**?").

   Fixed-weight fusion beats either signal alone and is trivial to reason about —
   no learned reranker, no RRF tuning to babysit. Recent conversation turns are
   scored the same way.

2. **Assemble under `max_tokens` with explicit triage priority** (the design
   decision the brief asks us to defend):

   1. **Stable user facts first** (`fact` + `preference`). Low-volume,
      high-value, and usually the thing a follow-up depends on. We surface **all**
      of them (budget permitting), most query-relevant first. Each carries a
      breadcrumb: `(updated 2026-03-15; previously Stripe)`.
   2. **Query-relevant opinions/events + recent conversation snippets**, ranked
      by the fused score and gated by a **relevance floor** (0.12) so off-topic
      chatter doesn't leak in.

   **Why this order:** stable facts are few and the highest-value context;
   recent chatter is the most recoverable if cut, so it's cut first. Surfacing
   *every* stable fact (rather than query-filtering them) is also what makes
   **multi-hop** work without a graph — "what city does the user with the dog
   Biscuit live in?" succeeds because both the pet fact and the location fact are
   simply present in the assembled context.

3. **Optional LLM compaction.** If the assembled context still overflows the
   budget (e.g. unusually long fact values), `provider.compact` asks the model to
   compress while keeping headers, dates, and supersession notes. The
   deterministic assembler already respects the budget, so compaction is a
   quality nicety, not a correctness crutch — disable it with
   `MEMORY_COMPACTION=off` for a fully deterministic, traceable path.

The output format mirrors the baseline's:

```
## Known facts about this user
- Lives in Berlin (updated 2026-03-15; previously NYC)
- allergic to shellfish (updated 2026-03-01)

## Relevant from recent conversations
- [2026-03-14] User mentioned preparing for a system design interview
```

**Cross-session scoping (intentional):** memories are scoped by `user_id` and
shared across that user's sessions — a follow-up in a *new* session still sees
the profile (this is the whole point of long-term memory). Different users never
bleed. `/recall` and `/search` scope recent *turns* to the session when given
one, falling back to the user. A cold user / undiscussed topic returns
`{"context": "", "citations": []}` — never a hallucinated memory.

---

## 5. Fact evolution — current wins, history kept

All of contradiction handling lives in **one method** (`store.addMemory`), on
purpose:

- **Mutable slot** (job, location, current opinion — `mutable=true`):
  - Same value as the active row → bump `confidence` + `updated_at` (no churn).
  - **Different** value → mark the active row `active=FALSE` and INSERT the new
    row with `supersedes` → the old row's id. The new fact is current; the old
    one is preserved as inactive history.
- **Additive slot** (allergies, distinct pets — `mutable=false`): dedupe on
  `(key, value)`; otherwise just INSERT (values coexist).

So "I work at Stripe" then "I just joined Notion" yields two `employment` rows:
Notion `active=true` (returned by `/recall` with a "previously Stripe" note) and
Stripe `active=false` (still inspectable, linked via `supersedes`). The
supersession key is the canonical `key` the extractor assigns, which is how two
phrasings of the same topic map to the same slot.

**Opinion arcs** ("I love TypeScript" → "TS generics are annoying" → "TS is fine
for big projects"): each new opinion on the same `preference:<topic>` slot
supersedes the prior one, so `/recall` shows the *current* stance while the full
arc remains in `/users/:id/memories` as the supersession chain. We model this as
"latest current value + preserved history" rather than reconstructing a narrative
of the arc — a deliberate simplification (documented as partial, per the brief).

---

## 6. Tradeoffs — what we optimized for, what we gave up

**Optimized for:** readability, inspectability, and a tiny dependency/seam
surface. One ingestion pipeline you can trace linearly; one place for the store;
one place for the LLM; one method for fact evolution; a recall ranker that fits
on a screen.

**Gave up (on purpose):**

- **No entity graph / multi-hop traversal.** We get multi-hop "for free" by
  always surfacing stable facts, which works for the common cases but won't chain
  arbitrary relations.
- **No multi-pass reconcile / dedupe loop.** One extraction pass, one upsert.
  Occasionally a near-duplicate slips through; we accept that over a fragile
  reconcile loop.
- **No learned reranker / RRF tuning.** Fixed-weight fusion is "good enough" and
  explainable.
- **Approximate token budgeting** (~4 chars/token) rather than a real tokenizer —
  within the spec's tolerance and one fewer dependency.
- **Precision over recall in extraction** — we'd rather miss a fact than store a
  wrong one.

These are the lines where the "opinionated" and "maxxed" variants spend their
complexity budget; this one doesn't.

---

## 7. Failure modes

- **No data / cold user / undiscussed topic:** `/recall` returns
  `{"context": "", "citations": []}` (200), never an error or a hallucination.
- **Missing API keys:** the service auto-selects the **deterministic offline
  provider** (`MockProvider`) — it still ingests, extracts (regex), embeds (hash),
  recalls, and persists. No crash, reduced extraction quality. Force it with
  `MEMORY_PROVIDER=mock`; force live with both keys present (or
  `MEMORY_PROVIDER=live`).
- **LLM / embedding call fails at runtime:** the turn is *already persisted*
  before extraction runs, so a failed extraction logs a warning and returns `201`
  anyway — the raw turn remains recoverable via `/search` and recent-turn recall.
  A failed embedding stores a `NULL` vector (that row simply scores 0 on the
  semantic axis; keyword overlap still works).
- **Malformed / oversized / unicode input:** Zod validation returns `422` (not a
  crash); unhandled errors return `500` via Hono's `onError`. Unicode/emoji and
  mixed-script (CJK) turns are handled. The process never goes down on bad input.
- **Slow disk:** pglite reads/writes the data dir synchronously within the
  request; a slow volume slows `/turns` and `/recall` but doesn't corrupt state.
  `/turns` has a 60s budget (per the contract), which is ample.
- **Misconfigured `*_BASE_URL`:** the live provider normalizes a base URL that's
  missing the `/v1` suffix (a common env-export mistake that otherwise 404s).

---

## 8. How to run the tests

```bash
npm install

# Offline test suite (LLM + embeddings mocked; no network, no keys):
npm test            # vitest run — 27 tests across 6 files
#   contract roundtrip · persistence across restart · cross-session scoping
#   · malformed/unicode robustness · fact evolution · recall-quality fixture

npm run typecheck   # tsc --noEmit, clean
npm run lint        # biome check ., clean
```

The **recall-quality fixture** (`fixtures/quality.json`, run by
`tests/quality.test.ts`) ships the design-specific probes — relocation, implicit
pet, job-change supersession, multi-hop, and a cold-user noise probe — and prints
`X/Y probes passed`.

### Run it for real (Docker)

```bash
# Eval default is container port 8080; this variant benches on host 8092:
HOST_PORT=8092 docker compose up -d
until curl -sf http://localhost:8092/health; do sleep 1; done

# With no keys it runs the offline provider. Supply keys to enable Claude+OpenAI:
#   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... HOST_PORT=8092 docker compose up

BASE=http://localhost:8092 npm run smoke   # ingest → recall → memories
```

### Live smoke (real models)

```bash
set -a; . ../../.env; set +a              # OPENAI_API_KEY + ANTHROPIC_API_KEY
MEMORY_PROVIDER=live MEMORY_DATA_DIR=/tmp/simple PORT=8092 npm start &
BASE=http://localhost:8092 npm run smoke
```

---

## File tree

```
implementations/simple/
├── src/
│   ├── server.ts      entrypoint (serve the Hono app)
│   ├── app.ts         the 7 endpoints + linear ingestion pipeline
│   ├── store.ts       pglite + vector: schema, supersession, hybrid scoring
│   ├── provider.ts    LLM/embedding seam: LiveProvider + MockProvider (injectable)
│   ├── recall.ts      hybrid fusion + budget-bounded assembly + optional compaction
│   ├── models.ts      Zod request schemas + response types (the wire contract)
│   ├── config.ts      env-driven settings + provider selection
│   ├── auth.ts        optional bearer-token middleware
│   ├── text.ts        keyword tokenization/overlap
│   └── tokens.ts      ~4 chars/token budget estimate
├── tests/             contract · persistence · scoping · robustness · evolution · quality
├── fixtures/quality.json   recall-quality probes
├── scripts/smoke.sh   §6 smoke script
├── Dockerfile · docker-compose.yml · .env.example · CHANGELOG.md
```
