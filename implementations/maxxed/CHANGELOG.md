# Changelog — maxxed

The design story. The brief was "kitchen-sink: cover every category." The arc
below is how the pipeline got there, what each step measured against the
`fixtures/quality.json` probe set (12 probes spanning recall, fact-evolution,
multi-hop, temporal, noise, extraction), and where I'd cut if forced to ship lean.

> Metric below = probes passed on the offline (mock-LLM) `quality` fixture, the
> red/green gate I ran after every change. Offline because it's deterministic and
> drives the same pipeline as live.

---

## v0 — Skeleton over the baseline shapes

**What:** Stood up the Hono contract (7 endpoints + 2 admin), swapped the
baseline's better-sqlite3 for **pglite + pgvector**, kept request/response shapes
byte-compatible with the root baseline so the shared harness scores us.

**Why pglite:** one embedded relational store that also does vectors and FTS —
facts, history, embeddings, and the graph all in one place, persisted to a
`dataDir` on a volume, with synchronous reads-after-writes. No second container.

**Result:** contract roundtrip green. Recall was still profile-dump only.

---

## v1 — Extract → reconcile loop (ADD / UPDATE / SUPERSEDE / NOOP)

**What:** Replaced "store messages" with a real extraction pipeline: LLM
`generateObject` extracts typed candidates, then a *second* structured call
decides each candidate against existing slot memories — ADD/UPDATE/SUPERSEDE/NOOP
(mem0/LangMem family, re-derived). Invalidate-don't-delete supersession with a
`supersedes` link + an append-only `memory_history` ledger.

**Why:** the spec's headline hard problem is fact evolution; a structured
decision per memory solves dedup + correction + contradiction in one place, and
NOOP doubles as a cheap noise filter.

**Result:** Stripe→Notion and Berlin→NYC supersession chains correct and
inspectable. `quality`: **7/12** (recall + evolution categories passing;
multi-hop, temporal, noise, some intent-gap recalls still missing).

**Observed bug:** "I left Stripe and joined Notion" extracted one garbage event
(`left_job:stripe and joined notion`) and never an employer change — greedy
regex in the rule shadow. Fixed by stopping captures at clause boundaries and
adding a `joined X` rule; also stripped temporal tails so "New York City next
month" → "New York City".

---

## v2 — Hybrid retrieval + RRF + LLM rerank

**What:** `/recall` and `/search` now run **dense kNN + lexical FTS** over
memories and turns, fused with **Reciprocal Rank Fusion**, then **LLM-reranked**,
with the final order blending rerank (precision) and RRF (recall). Added query
rewrite/expansion before retrieval.

**Why:** pure vectors miss keyword queries ("what's the dog's *name*?") and pure
keywords miss paraphrase ("where do they *live*" vs a "location" slot). RRF is
rank-based so the wildly different cosine vs `ts_rank` scales don't fight.

**Result:** keyword-dependent recalls recovered. `quality`: **9/12**.

---

## v3 — Multi-hop via an entity-link graph

**What:** Extraction tags each memory with `entities` and links co-referent
memories into a `memory_links` graph (shared-entity strong edges + `same_subject`
weak edges across a user's identity facts). Recall seeds from the query's named
entities and does **one-hop expansion** from the top fused memories.

**Why:** "what city does the owner of the dog named Biscuit live in?" is two
disjoint memories; naive top-k can't bridge them. Entity seeding connects
"Biscuit" → the pet memory; one hop reaches the city.

**Result:** the canonical multi-hop probe resolves. `quality`: **10/12**.

---

## v4 — Temporal reasoning + budget-aware tiered assembly

**What:** Bi-temporal columns (`valid_from`/`valid_to`); an `as_of` query param
with a point-in-time view (`memoriesAsOf`) so "where did Alice work in Feb 2026?"
returns *Stripe*, not the latest. Assembly became explicitly tiered — stable
facts → query-relevant → recent — rank-then-truncate under `max_tokens`, with an
LLM compaction pass + hard-trim guard so we never exceed budget by 2×.

**Why:** temporal correctness is its own graded category, and "context assembly
under budget" is a core design decision the spec asks us to defend.

**Result:** temporal probe correct; budget probes stay under their cap.
`quality`: **10/12** (the two stragglers were noise + an intent-gap recall).

---

## v5 — Abstention gate (noise resistance) + intent safety net

**What:** The hardest tension in the brief: the always-on profile (great for
recall/multi-hop) fought the abstention category (which wants *empty* on
never-discussed topics). Resolution: a **relevance gate** surfaces the profile
only when the query is genuinely on-topic — a union of signals (reranked memory
above floor, named entity, *lexical* turn hit, or intent/lexical overlap). I
deliberately **excluded raw dense/fused scores** from the gate: vector similarity
gives a small score to almost everything, which is exactly the noise failure mode.
Added an intent-synonym map ("live"→"location", "dietary"→"diet/vegetarian") as a
deterministic safety net under the LLM reranker for terse queries.

**Why:** abstention is graded, and "don't hallucinate the profile at an off-topic
query" is the behavior reviewers look for.

**Result:** noise probe abstains; intent-gap recall recovered. `quality`:
**12/12**. Full suite: 34/34 tests green, tsc + biome clean.

---

## What I'd cut to ship lean

If forced to a minimal, cheap, low-latency service, in order of what goes first:

1. **LLM compaction** — rare path (only when a fact block overflows); a hard
   char-trim covers it. Saves a call.
2. **Query rewrite/expansion** — the reranker + intent map recover most of its
   value. Saves a call.
3. **Per-candidate LLM reconcile** — collapse to the deterministic heuristic
   (same-value → NOOP; mutable + existing → SUPERSEDE; else ADD) that the offline
   path already uses; reserve the LLM only for ambiguous slots. Saves N calls per
   turn.
4. **The graph layer** — entity-seeding alone (no link table / one-hop) keeps
   most multi-hop wins at a fraction of the write cost.

The irreducible core I'd never cut: **typed extraction + invalidate-don't-delete
supersession + hybrid (dense+lexical) retrieval + tiered budget assembly**. That
core is what separates a memory service from a message log, and it's what the
eval scores hardest.

---

## Known limitations / next steps

- **Opinion arc** is a supersession chain, not a learned sentiment trajectory —
  it returns the latest stance + history, not a synthesized "arc" summary.
- **Multi-hop is one-hop.** Chained (n-hop) reasoning would need query
  decomposition or PPR over the graph — the documented upgrade path.
- **Exact kNN** — fine at this scale; add an HNSW index (one line) if volume grows.
- **No background reflection/rollups** — every memory is written synchronously on
  the turn; hierarchical summaries (RAPTOR/Zep-style) are a future enhancement.
