# Changelog

Iteration log for the memory service. One entry per significant design iteration:
what changed, why, what we observed, what's next. Newest first.

## Plan — four implementations, one benchmark

**v0 (below) is the starting point**: a deployable, contract-complete control.
From here we explore three independent designs, each in its own folder, then
benchmark all four against each other to see where we stand.

**The four implementations**

| # | Name | Location | Idea |
|---|------|----------|------|
| 1 | **Baseline / control** | `/` (root) | The cheap, deterministic, no-LLM floor. TypeScript + better-sqlite3 + rule-based extraction + lexical recall. Stays as-is — it tells us what the floor is. |
| 2 | **Opinionated** | `implementations/opinionated` | A strong point of view, executed: synchronous extract→reconcile, context-enriched facts, contradictions linked (not deleted) and narrated. |
| 3 | **Simple & transparent** | `implementations/simple` | Minimal moving parts, readable & inspectable — the design a maintainer groks in five minutes. |
| 4 | **Maxxed** | `implementations/maxxed` | Kitchen-sink: extract→reconcile, hybrid + RRF + LLM rerank, entity-graph multi-hop, temporal reasoning. |

**Shared stack for the three explorations** (the v0 control keeps its
SQLite/rule-based stack so we can measure what the additions buy us):

- **Runtime:** TypeScript + Node + Hono
- **LLM/embeddings interface:** **Vercel AI SDK**
- **Store:** pglite (`@electric-sql/pglite`, embedded Postgres) + vector extension
- **Embeddings:** OpenAI `text-embedding-3-large` (3072-dim)
- **LLM:** Claude **Opus 4.8** (`claude-opus-4-8`) for extraction / reconciliation / recall
- **Cost:** **not** optimizing for LLM cost or latency yet — chase the quality ceiling first.

**How we compare:** the HTTP benchmark harness (`bench/`) plus a shared fixture,
scored by an LLM judge. Each implementation appends its own entries (in its folder
CHANGELOG) as it iterates; the winner (or hybrid of winners) gets promoted to the
root baseline.

---

## v3 — Full matrix re-run (bugs fixed), Haiku vs Opus, model-aware cost, contradiction fixture

**What changed:**
- **Re-ran the whole suite after fixing the two v2 bugs** (opinionated's recall 500,
  maxxed's extraction schema-mismatch). opinionated's `ruler-niah` recovered
  **33% → 100%** on Opus; the v2 "bug artifact" caveats are now retired.
- **Ran every benchmark on both Opus 4.8 and Haiku 4.5** (the chat model is a
  container parameter, `MEMORY_LLM_MODEL`), with **5× the probe count** on the
  cheap Haiku pass. Finding: **Haiku holds accuracy within a few points of Opus**
  on a larger sample — a viable default.
- **Made the cost axis model-aware.** `bench/suite/runner.ts` previously priced
  *every* card at Opus rates, overstating Haiku ~10–15×. Added `priceFor(model)`
  (opus/sonnet/haiku tiers), recorded `pricing_model`/`pricing_rates` on each card,
  and a `restamp-cost.ts` to correct already-written cards. Both run scripts now
  export `MEMORY_LLM_MODEL` so the runner prices at the model the servers used.
- **Built the `contradiction` fixture** (`bench/suite/adapters/contradiction.ts`)
  to test opinionated's signature link-don't-supersede thesis head-on, and a
  port-safe `scripts/run-contradiction.sh` (never broad-pkills).

**What we observed:**
- **`simple` is the standout** on every benchmark and both models — top-or-tied
  accuracy, lowest cost/latency, most Haiku-robust (the tradeoff is larger recall
  context). `maxxed` matches it on easy benchmarks but degrades most under Haiku.
- **`opinionated`'s per-fact reconcile fan-out is the cost driver** — 3–8× more LLM
  calls than `simple` (1101 vs 400 on ruler, 290 vs 34 on longmemeval) for no
  accuracy premium. Haiku collapses absolute cost (worst card $7.12 → $2.56) but
  not the ranking (cost is call-count-bound, not per-token).
- **The contradiction fixture did NOT prove opinionated ahead.** The reason-as-CoT
  change (opinionated v6) fixed its tension probes to a perfect 5/5 with the richest
  narration, but it nets 90% (over-narrated one unsettled fact as "finalized",
  failing a control probe), while **`simple` and `maxxed` both hit 100% at 1/7 and
  1/2 the cost**. The live extractor files conflicting statements under different
  keys, so the supersede builds surface both sides anyway — defeating the fixture's
  attempt to isolate opinionated's edge.

**Verdict / what's next:** if we shipped one, **`simple` on Haiku**, grafting in
opinionated's narrated-contradiction idea only where a use case needs the prior side
surfaced. Full numbers in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md). Remaining gaps:
LoCoMo on the LLM builds (a multi-hour batch) and larger N on the standard
benchmarks for the LLM builds.

---

## v2 — Benchmark suite (LongMemEval / LoCoMo / RULER-NIAH / custom)

**What changed:** Built a reusable suite ([`bench/suite/`](bench/suite)) — a
normalized Scenario format + Opus-judged runner computing the mem0 three-axis card
(accuracy-by-category / tokens-per-recall / p50–p95 latency). Adapters: LongMemEval
(real `oracle`, 500 instances), LoCoMo (real `locomo10.json`, CC BY-NC), RULER/NIAH
(deterministic length-scalable generator), and custom (the assignment scenarios).
Developed via parallel background agents; datasets stay git-ignored. Added
[`scripts/run-suite.sh`](scripts/run-suite.sh), which runs every benchmark × all
four implementations as **concurrent** sequences (collapses the LLM phase to the
slowest build instead of the sum).

**Why:** the v1 comparison used a 12-probe custom fixture only — too small to
separate the LLM builds. The suite adds real long-memory datasets + a synthetic
volume/noise generator, scored like the private eval, across the rubric categories.

**Result** (bounded subset; full table: [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)):
the baseline floor is genuinely low on realistic data — **LoCoMo 10%, LongMemEval
45%** (vs ~ms latency) — which is the argument for the LLM builds. On the tractable
subset, **simple** and **maxxed** lead; **opinionated** matches on custom/longmemeval
but has the heaviest ingest. Cost shapes: opinionated costliest ingest (~16–24 s/turn,
p95 ~47 s), maxxed costliest recall (~7–9 s, p95 ~41 s), simple the balance.

**Validity (checked + documented, NOT fixed per direction):** no rate limiting
(0 throttle signatures, 0 judge errors). Two real bugs found and left as caveats —
`opinionated` 3× HTTP 500 (`TypeError ... reading 'value'`) which voids its
ruler-niah number (empty recall), and `maxxed` 5× extraction schema-mismatch →
silent rule fallback (mild understatement). LoCoMo is **baseline-only** here
(full-conversation LLM ingestion is a separate long batch). Small N on the LLM
longmemeval/ruler runs.

**Next:** fix the two bugs; run LoCoMo (and larger N) against the LLM builds for a
clean comparison; then decide which design to promote.

---

## v1 — Three explorations built + shared LLM-judged comparison

**What changed:** Built all three explorations as self-contained, docker-deployable
services (TS + Hono + pglite/pgvector + Vercel AI SDK, `text-embedding-3-large` +
Claude Opus 4.8), each to a shared spec ([`implementations/README.md`](implementations/README.md)).
Switched the exploration model from git branches to **folders**. Added a shared,
harder benchmark ([`bench/scenarios/comparison.json`](bench/scenarios/comparison.json)),
an **LLM-judged comparison harness** ([`bench/report.ts`](bench/report.ts)), and a
one-command orchestrator ([`scripts/run-comparison.sh`](scripts/run-comparison.sh))
that boots all four on distinct ports, runs the report, and tears down. Removed the
assignment brief from version control (kept locally, gitignored). Isolated the
sub-projects from root tooling (biome/vitest/docker scope to the baseline only).

**Why:** the per-implementation fixtures weren't comparable (different sizes/probes,
all easy). A real comparison needs **one** harder fixture run identically against
all four over the same HTTP contract, scored by an LLM judge — mirroring how the
assignment's private eval works — across the categories that actually separate
designs (paraphrase, fact evolution, opinion arc, multi-hop, abstention, budget).

**Result** (full report: [`docs/COMPARISON.md`](docs/COMPARISON.md)):
- **Formal requirements:** all four pass every §3/§5/§6 check (endpoints, shapes,
  status codes, persistence, structured memories, docker/compose, docs).
- **Benchmark** (12 probes, Claude Opus 4.8 judge):

  | impl | judge pass | avg recall ms | avg ingest ms |
  |---|---|---|---|
  | baseline | 4/12 (33%) | 5 | 1 |
  | opinionated | 11/12 (92%) | 3823 | 9865 |
  | simple | 11/12 (92%) | 491 | 4137 |
  | maxxed | 12/12 (100%) | 5251 | 4149 |

- **Findings:** the v0 floor is confirmed (brittle lexical extraction fails
  paraphrase/job-phrasing/"moving"/implicit). Among the LLM builds the aggregate is
  near-tied; the real differences are per-category and cost: **opinionated** misses
  the multi-step opinion arc and has the costliest ingest (~10s/turn, per-fact
  reconcile); **simple** misses noise-abstention (always-on profile, no relevance
  gate) but has the fastest recall (~0.5s); **maxxed** is the only clean sweep but
  the costliest recall (LLM rerank+compaction in the hot path). All three context
  budgets stay tight (~32–43 tokens). All three independently hit the same provider
  quirk (`claude-opus-4-8` rejects `temperature`; `ANTHROPIC_BASE_URL` needs `/v1`).

**Next (analysis only — not yet implemented):** scale the benchmark with a real
dataset (LongMemEval / LoCoMo) so 92% vs 100% is statistically meaningful; tighten
the abstention rubric (judge leniency observed); then per-build fixes — opinionated:
opinion-arc synthesis + cheaper ingest; simple: an abstention/relevance gate;
maxxed: trim recall latency + n-hop. No promotion decision yet.

---

## v0.1 — Port the control to TypeScript

**What changed:** Rewrote the v0 control from Python/FastAPI to **TypeScript +
Hono + better-sqlite3**, keeping behaviour identical. Toolchain moved to the Node
ecosystem: **Biome** (lint+format), **Vitest** (tests), **tsx** (run TS directly,
no build step), **Zod** (request validation). Benchmark harness and the
requirements guardrail were ported to TS; smoke test (curl) is unchanged.

**Why:** the three exploration implementations use the Vercel AI SDK and pglite,
both first-class in the TS/JS ecosystem (pglite is natively a WASM/JS package).
Putting the control on the same toolchain means one language, one set of
guardrails, and an apples-to-apples comparison where only the *design* differs.

**Result:** behaviour preserved — self-eval fixture **7/7 probes (100%)**, full
Vitest suite green (contract, persistence, cross-session scoping, robustness,
fact-evolution), container boots via `docker compose up` on :8080, data survives
`docker compose down && up`. CI is Node-based (biome → typecheck → requirements →
vitest → docker smoke → restart-persistence → bench).

**Next:** branch the three explorations onto the shared pglite + Vercel AI SDK +
Opus stack and benchmark them against this control.

---

## v0 — Baseline / control: full contract, offline, deterministic

**What changed:** First end-to-end slice and the control for the comparison above.
All seven contract endpoints over an embedded SQLite database (single file on a
Docker volume). Rule-based extraction of typed memories (employment, location/moves,
pets incl. implicit, diet, allergies, preferences, names, family). Keyword-overlap +
recency + type-priority recall with budget-bounded assembly. Fact-evolution via
key-based supersession (old row kept, `supersedes` chain, current value returned).
Pluggable Extractor/Recaller behind env-selected factories.

**Why this shape first:** the spec rewards iteration with metrics over a single
clever shot. A deterministic, offline baseline makes the self-eval loop and CI
instant and reproducible (no network, no flakiness), and gives every branch a
measurable floor to beat. It is intentionally the no-embeddings, no-LLM control.

**Result:** self-eval fixture **7/7 probes (100%)**; verified in the real container
(`docker compose up` on :8080, data survives a restart, bench 7/7). Guardrails:
`scripts/check-requirements.*`, pre-commit (lint+format, secret detection, the
requirements check), and GitHub Actions CI.

> Note: v0 was originally prototyped in Python/FastAPI; v0.1 ported it to
> TypeScript. The design and behaviour are unchanged.
