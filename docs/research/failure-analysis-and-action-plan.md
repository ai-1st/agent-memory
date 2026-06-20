# Failure analysis & improvement action plan

What each implementation gets wrong, *why* (grounded in the benchmark judge notes
and the source), and a per-implementation action plan that respects the design
contract for each: **keep `simple` simple, keep `opinionated` true to its original
idea, let `maxxed` grow new layers freely.**

## Data sources

Haiku 4.5 (post-bugfix), Opus judge. longmemeval **N=40**, ruler-niah **N=30**,
contradiction **N=10**, LoCoMo **N=100**, adversarial **N=30**. Strict-floor
(score≥0.8) available per card. LoCoMo for opinionated/maxxed and the adversarial
run land in the **Appendix** as they complete; they *quantify* the modes below but
don't change the diagnosis (the modes are already visible in the landed cards +
source).

## Cross-cutting failure taxonomy

| # | Mode | Who | Evidence |
|---|------|-----|----------|
| **T1** | **Temporal arithmetic** — surfaces raw dates but doesn't compute durations / ordering / relative-date answers | all three | longmemeval fails are *almost entirely* `temporal`: simple 10/10, maxxed ~12, opinionated ~9. Notes: "implies two weeks but does not state it", "cannot derive 'five months ago'", "no purchase-order to determine which first". |
| **T2** | **Retrieval coverage collapse on long multi-session** — relevant facts not pulled; speakers conflated | simple (worst) | LoCoMo simple **24%**, 76 fails: "Context contains no information about X", and attribution slips (Caroline's facts returned for Melanie). |
| **T3** | **Empty recall on low-semantic needles** — LLM rerank/compaction drops a random-string hit → empty context | opinionated | ruler recall **5/6** fails are literally "Context is empty; no access code provided" (simple dumps candidates → 100%). |
| **T4** | **Over-narration** — compaction asserts an ordering/resolution the facts don't support | opinionated | longmemeval "timeline section incorrectly…", "summary reaches the wrong conclusion"; contradiction control "claims Denver is finalized" (expected: undecided). |
| **T5** | **Loses earlier values in A→B→C** — only the most-recent prior kept as a breadcrumb | simple, maxxed | source: `simple/src/recall.ts:192` & `maxxed/src/recall/recaller.ts:392` both `note += ; previously ${prior[0]}`. Quantified by adversarial `history_full`/`stale_trap` (Appendix). |
| **T6** | **Weak abstention under distractors** — returns a near-miss instead of abstaining | maxxed | ruler `noise_abstention` 4 fails: "contains X5-QW77 which could be misinterpreted as an access code… does not clearly convey nothing is known". |
| **T7** | **Multi-hop chaining** — second-hop entity not retrieved | all | ruler + LoCoMo `multihop`: "establishes the user is in Gaborone but does not name the SRE". |

## Per-implementation

### `simple` — keep it simple (surgical fixes only; no new subsystems)
Failures: **T1** (temporal), **T2** (LoCoMo coverage), **T5** (prior[0]).
- **T5 — one-liner:** join all priors instead of `prior[0]` → "previously Globex; before that Acme". Keeps the single-breadcrumb shape, recovers full history.
- **T1 — extraction prompt tweak:** anchor relative dates to the turn timestamp *at ingest* ("about three weeks ago" → "around 2023-05-01"), so recall surfaces absolute dates a frozen LLM can compute with. No temporal engine added.
- **T2 — widen + scope:** raise the recall candidate breadth (semantic limit) and scope facts by speaker/user so multi-speaker conversations don't conflate. A parameter + filter change, not a new layer.
- **Explicitly NOT doing:** LLM reranker, entity graph. `simple` stays the transparent dump-with-triage design.

### `opinionated` — stay true to the original idea (linked contradictions + LLM rerank/compaction)
Failures: **T3** (empty recall), **T4** (over-narration), **T1** (temporal).
- **T3 — retention guard:** never let the LLM compaction zero out a clear hit. If a candidate has a high embedding similarity *or* exact-substring match to the query but the LLM returns empty/!selected, include it via the existing deterministic fallback. Keeps LLM-as-reranker; adds a safety net (same class as the recall fallback already there).
- **T4 — tighten the narration prompt:** narrate only what the dated facts state; never assert an ordering or a *resolution* not supported by a fact. For contradictions, narrate the tension as **unresolved** unless an explicit resolution fact exists (directly fixes the "Denver finalized" control miss while keeping the narration identity).
- **Correction vs reversal (from adversarial `slot_collision` 2/3):** route an explicit *correction* ("no wait, it's Y") to a clean UPDATE/supersede; reserve keep-both + link for genuine preference/opinion *reversals*. Removes the ambiguity that costs the slot-collision probes without abandoning keep-both where it earns its keep (multihop 4/4, stale_trap 3/3).
- **T1 — shared date-anchoring** (below).
- **Keep:** the CONTRADICT link graph + tension narration — adversarial proves it's worth keeping (multihop 4/4, temporal_duration 2/2 — best of all builds).

### `maxxed` — free to add layers
Failures: **T1** (temporal), **T6** (abstention), **T7** (multi-hop), **T5** (prior[0]).
- **T1 — temporal layer:** anchor relative dates at ingest *and* add a recall step that computes durations/ordering when the query is temporal.
- **T6 — abstention gate:** an explicit "does any retrieved fact actually answer this?" check before returning, to suppress lexically-near distractors.
- **T7 — multi-hop expansion:** when the query names an entity, expand retrieval to facts about the linked entity (1–2 hops) before reranking.
- **T5 — full history:** join all priors / surface superseded rows on demand.

## Shared opportunity
**Date-anchoring at extraction (T1)** is the single highest-leverage fix — it's the
dominant longmemeval failure for *all three* builds. Implement the prompt pattern
once and adopt it in each extractor. It's "simple-safe" (prompt-only) so even
`simple` can take it without violating its contract.

## Priority (by impact × effort)
1. **T1 date-anchoring** — biggest accuracy lever, prompt-only, all three builds.
2. **T3 opinionated retention guard** — turns 5 empty ruler recalls into hits.
3. **T5 all-priors breadcrumb** — one-liner in simple & maxxed.
4. **T2 simple coverage** — the LoCoMo floor; param + speaker scoping.
5. **T6 / T7 maxxed layers** — abstention gate, multi-hop expansion.
6. **T4 opinionated narration discipline** — prompt tightening.

## Appendix — completed results

### LoCoMo (N=100, realistic long multi-session)
baseline **15%** → simple **24%** → maxxed **26%** → opinionated **27%**. LLM
builds cluster ~10–12 pts over the floor; **73 pts of headroom** — measure the
improvement work here.

### Adversarial (N=30) — the discriminating set, per category

| category | baseline | simple | maxxed | opinionated |
|---|---|---|---|---|
| stale_trap | 1/3 | 2/3 | 2/3 | **3/3** |
| history_full | 0/3 | 0/3 | 1/3 | 1/3 |
| leak_control | 0/4 | 3/4 | 3/4 | 3/4 |
| slot_collision | 0/3 | **3/3** | **3/3** | 2/3 |
| abstain_distractor | 4/6 | 5/6 | 5/6 | 5/6 |
| multihop_decoy | 0/4 | 2/4 | 3/4 | **4/4** |
| temporal_order | 1/3 | 2/3 | 1/3 | 2/3 |
| temporal_duration | 0/2 | 0/2 | 1/2 | **2/2** |
| control_easy | 0/2 | 2/2 | 2/2 | 2/2 |
| **OVERALL** | **20%** | **63%** | **70%** | **80%** |

**This is the result that reverses the earlier "no accuracy premium" read** (that
read came from saturated/low-N probes). On a set that actually discriminates:

- **opinionated's design pays off on hard reasoning** — `multihop_decoy` 4/4 (its
  link-following recall chains entities), `temporal_duration` 2/2, `stale_trap`
  3/3. This is the empirical case *for* keeping opinionated.
- **opinionated's one backfire — `slot_collision` 2/3** (simple/maxxed 3/3):
  keep-both creates ambiguity when the user merely *corrected* a value rather than
  reversed a preference. **New action item (true to the idea):** route explicit
  corrections ("no wait, it's Y") to a clean UPDATE/supersede; reserve keep-both +
  link for genuine preference/opinion reversals. Same root as T4.
- **`history_full` is hard for everyone** (≤1/3) — confirms T5 is a real, shared
  gap; the all-priors breadcrumb fix targets it directly.
- **abstention barely separates** (all ~5/6, baseline 4/6) — T6; maxxed's gate is
  the place to fix it.
- **temporal_order still weak for all** (1–2/3) — T1 remains the top shared fix.

## Phase-1 results — date-anchoring at extraction (Haiku, LoCoMo N=100)

Threaded the turn timestamp into extraction for all three builds + instructed
relative→absolute date resolution ("last Saturday" → 2023-05-13, baked into the
value). Validated live. LoCoMo before→after:

| build | overall | temporal | multihop | recall |
|---|---|---|---|---|
| simple | 24→**30** | 5→14 | 19→25 | 52→55 |
| maxxed | 26→**23** ⚠️ | 5→5 | 19→19 | 58→48 |
| **opinionated** | 27→**42** | **16→46** | **13→34** | 55→45 |

**Anchoring pays off only where the recall layer USES the dates.** opinionated's
LLM rerank/compaction narrates with the dates (temporal +30, multihop +21) →
**+15 overall, now 42%**. maxxed's compaction strips dates back out (temporal flat)
and baking dates into values drifted embeddings enough to cost single-hop recall
(58→48) → **net −3**. simple just dumps context: modest gains on "what-date" probes.

**Two side-effects to fix:** (1) maxxed needs date-PRESERVATION in its recall
prompt before anchoring helps it; (2) inlining dates into `value` hurts non-temporal
retrieval (embedding drift) — embed on key+undated text, keep the date for display.

**Reframed diagnosis (from opinionated's residuals):** the remaining LoCoMo
failures are dominated by **missing facts** — "no record of X documented", "no
signup date documented", "never specifies Sweden" — i.e. **extraction completeness
+ retrieval coverage**, NOT temporal arithmetic. The dates that exist already work.
A subset of `recall` misses are cat3 commonsense-inference questions (subjective,
some judge-debatable). So Lever 2 is **denser extraction on long sessions + wider
recall**, focused on **opinionated** (the build that responds to the levers and is
approved to develop as-is). Honest ceiling unchanged: ~55–65% is a strong target;
<20% failure remains a stretch given cat3 subjectivity + extraction limits.

## Lever-2/3 results — coverage sweep (opinionated, LoCoMo N=100, Haiku)

Two ideas explored on top of date-anchoring (42%), via a 4-way A/B sweep:
- **multi-query retrieval** (recall-side): LLM proposes follow-up queries from the
  first-round facts, merges results.
- **chunked extraction** (ingest-side): extract from each focused message-chunk AND
  the whole turn, then semantic-dedup the candidates.

| config | LoCoMo | vs base | verdict |
|---|---|---|---|
| base (Lever-2: exhaustive prompt + wider recall) | **57%** | — | the wider-recall + exhaustive-extraction prompt alone is +15 over Lever-1 (42%) |
| + multi-query | 55% | −2 | **no help** — Lever-2's wider recall already pulls what the extra queries would; the added LLM call is cost+noise |
| **+ chunked extraction** | **67%** | **+10** | **the winner** — a focused window surfaces one-off details the single long pass drops (the dominant coverage residual) |
| + both | 66% | +9 | chunk's gain; mq still adds nothing |

**Decisions:** opinionated adopts **chunked extraction ON by default**, multi-query
**off** (kept env-gated for experimentation). Net opinionated LoCoMo: 27% (pre-anchor)
→ 42% (anchoring) → 57% (coverage prompt + wider recall) → **67% (chunked extraction)**,
clearing the ~60% target. Coverage — getting the fact into the store and into the
candidate set — is the dominant lever on LoCoMo, exactly as the residual analysis predicted.

## Per-build improvement iterations (LoCoMo, Haiku N=100)

Goal: 3 iterations per build, benchmarked + committed each. Key cross-build lesson:
**coverage (more extracted facts) helps only builds with a reranker that triages a
budget-capped context.** It backfires where the build dumps facts without reranking.

| build | baseline (anchored) | iter-1 | lever | verdict |
|---|---|---|---|---|
| **opinionated** | 42% | **67%** | chunked extraction (default-on) | **+25 win** — has an LLM reranker; coverage pays off |
| **simple** | 30% | 24% → reverted | exhaustive extraction | **backfired** (−6): no reranker, dumps a budget-capped context, so more facts crowd out the needle. Kept the all-priors breadcrumb; iter-2 pivots to SELECTION quality (date boost + stable-budget cap) |
| **maxxed** | 23% | 22% | exhaustive extraction | **flat**: maxxed retrieves only top-K=20 and never "always includes all facts", so extracting more didn't reach recall. iter-2 = chunked extraction + RETRIEVE_K 20→50 (widen the pool the reranker sees) |

The pattern confirms the diagnosis: on LoCoMo the gate is **getting the right fact
into the candidate set the reranker scores**. opinionated already includes all stable
facts + links + wide semantic recall, so chunked extraction (more facts in the store)
converts directly. maxxed/simple needed their retrieval/selection widened first.

## maxxed coverage levers FLOOD the pipeline (iter-1/iter-2 — measured negatives)

maxxed is the playground; we pushed coverage hard and it backfired, twice:

| maxxed iter | lever | LoCoMo | recall cat | tok/recall p50 |
|---|---|---|---|---|
| baseline (anchored) | — | 23% | 48% | 999 |
| iter-1 | exhaustive extraction | 22% (flat) | 39% | 1003 |
| iter-2 | chunked extraction + RETRIEVE_K 20→50 | **12%** (−11) | 16% | **0** |

**Root cause:** maxxed's recall is a multi-step pipeline (rewrite → hybrid+RRF →
graph-expand → LLM rerank → abstention gate → assemble → LLM compact). Flooding it
with candidates spreads the rerank scores thin, so **nothing clears the abstention
floor and recall returns EMPTY** (tok/recall p50 → 0 on iter-2). Its separate
rerank+compact steps don't scale with candidate volume — the exact opposite of
opinionated, whose single rerank-and-write absorbs more candidates gracefully.

**Lesson:** "coverage helps builds with a reranker" is too coarse — it needs a
reranker that *triages a large set in one pass*. maxxed's staged pipeline doesn't.
Both coverage levers were **reverted**. iter-3 pivots to **precision**: a temporal
date-boost so dated facts (its worst category, temporal 5%) rank into the budget —
no change to candidate volume.
