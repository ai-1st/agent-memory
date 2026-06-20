# Benchmark suite results

Generated from the benchmark suite ([`bench/suite/`](../bench/suite)) — four
public/standard benchmarks plus one purpose-built fixture, all normalized to one
HTTP contract and scored by an **LLM judge** (Claude Opus 4.8) on the **mem0
three-axis card**: accuracy-by-category / tokens-per-recall / p50–p95 latency,
with a **cost** axis added (token spend × per-model price). Reproduce with
`bash scripts/run-suite.sh` (full matrix) or `bash scripts/run-contradiction.sh`
(the contradiction fixture); raw cards land in git-ignored `bench/results/suite/`.

**Two model runs.** The whole suite was run twice — once on **Opus 4.8**, once on
**Haiku 4.5** — to measure the accuracy/cost tradeoff of the cheap model. The
chat model is a container parameter (`MEMORY_LLM_MODEL`); the cost axis prices each
card at the model it actually ran on (`bench/suite/runner.ts → priceFor()`), so
Haiku cards are no longer mis-priced at Opus rates. The Haiku run used **5× the
probe count** of the Opus run (it's cheap), so Haiku accuracy is the more
statistically reliable column even though the two columns aren't probe-for-probe
identical.

**Run shape (cost-bounded, parallel).** The four implementations ran as concurrent
sequences. `baseline` (free, no LLM) ran every benchmark at full-ish N; the LLM
builds ran the *tractable* benchmarks at smaller N. **LoCoMo now runs on the LLM
builds too** (N=100, one conversation), and a new **`adversarial`** fixture targets
the discriminating cases. N (probes) is shown next to each cell; small N ⇒ ranking
signal, not a precise rate. See the
[probe-discrimination audit](research/probe-discrimination-audit.md) for why N
matters and the [Reading](#reading--updated-after-the-discriminating-runs-n40-locomo-on-llm-builds-adversarial)
section for the conclusion.

## Validity caveats (read first)

We scanned every service + run log for rate limits and errors:

- **No rate limiting.** Zero `429` / `overloaded` / `timeout` / `ECONNRESET`
  signatures across all services; **0 judge errors**. Parallelizing introduced none.
- **The two bugs from the previous milestone are FIXED** (and the numbers below are
  the post-fix re-run):
  - `opinionated`'s 3× HTTP 500 on recall (`util.inspect` throwing in a catch's
    logger) — fixed with a safe `errStr()` logger + guards. Its `ruler-niah` score
    went **33% (bug artifact) → 100%** on Opus.
  - `maxxed`'s 5× extraction schema-mismatch → silent rule fallback — fixed with
    `z.preprocess` normalization + retry + repair.
- **Cost was previously priced at Opus rates for every card** (a runner bug),
  overstating Haiku ~10–15×. Now model-aware; Haiku cards re-stamped.

## Axis 1 — Accuracy (judge pass rate, N = probes)

**Opus 4.8:**

| Benchmark | baseline | simple | maxxed | opinionated |
|---|---|---|---|---|
| custom | 33% (12) | 100% (12) | 100% (12) | 100% (12) |
| longmemeval | 50% (20) | 100% (3) | 67% (3) | 67% (3) |
| ruler-niah | 100% (12) | 100% (6) | 67% (6) | 100% (6) |
| locomo | 10% (20) | — | — | — |

**Haiku 4.5 (5× probes — the reliable column):**

| Benchmark | baseline | simple | maxxed | opinionated |
|---|---|---|---|---|
| custom | 33% (12) | 100% (12) | 92% (12) | 100% (12) |
| longmemeval | 37% (100) | **93% (15)** | 73% (15) | 87% (15) |
| ruler-niah | 100% (60) | **100% (30)** | 80% (30) | 80% (30) |
| locomo | 15% (100) | 24% (100) | 26% (100) | **27% (100)** |
| adversarial | 20% (30) | 63% (30) | 70% (30) | **80% (30)** |

Notes:
- **Haiku barely costs accuracy.** Across the board it lands within a few points of
  Opus on a 5× larger sample. `simple` is the most Haiku-robust (93% / 100% / 100%);
  `maxxed` degrades most under Haiku (longmemeval 73%, ruler 80%) — its heavier
  multi-step pipeline is more sensitive to the weaker model.
- **`baseline` floor is genuinely low on realistic data** (LoCoMo 10–15%,
  LongMemEval 37–50%) — the whole argument for the LLM builds. It "wins" `ruler-niah`
  because exact-token needle retrieval is trivial for keyword match; discrimination
  there is at larger haystack depth.
- **`simple` leads or ties everywhere.** It is never the worst LLM build on any
  benchmark, on either model.

## Axis 2 — Cost (USD per run, model-aware)

Pricing ($/1M tokens): Opus 15 in / 75 out; Haiku 1 in / 5 out; embeddings 0.13.
`baseline` uses no LLM ⇒ $0. **calls** = LLM invocations per run.

| Benchmark | impl | Opus $ | Haiku $ | LLM calls (Haiku, 5× N) |
|---|---|---|---|---|
| custom | simple | 0.29 | **0.016** | 13 |
| custom | maxxed | 1.01 | 0.069 | 38 |
| custom | opinionated | 1.77 | 0.105 | 50 |
| longmemeval | simple | 0.85 | **0.226** | 34 |
| longmemeval | maxxed | 0.89 | 0.322 | 76 |
| longmemeval | opinionated | 3.67 | 0.894 | **290** |
| ruler-niah | simple | 1.47 | **0.428** | 400 |
| ruler-niah | maxxed | 3.47 | 1.236 | 521 |
| ruler-niah | opinionated | 7.12 | 2.557 | **1101** |

- **`opinionated`'s per-fact reconcile fan-out is the cost story.** It makes
  3–8× more LLM calls than `simple` for equal-or-lower accuracy: 290 vs 34 on
  longmemeval, 1101 vs 400 on ruler — one extract call per turn *plus* a parallel
  reconcile call per extracted fact. On Opus that's the $3–7/run we were chasing.
- **Haiku collapses the absolute cost** (worst card $7.12 → $2.56) but does **not**
  change the *ranking* — opinionated is still the most expensive by the same multiple,
  because cost here is dominated by call count, not per-token price.

## Axis 3 — Tokens per recall (context size, p50)

| Benchmark | baseline | simple | maxxed | opinionated |
|---|---|---|---|---|
| custom | 0 | 48 | 35 | 48 |
| longmemeval | 138 | **476** | 360 | **105** |
| ruler-niah | 43 | 117 | 136 | **51** |

`simple` returns the most context (it leans on dumping more); `opinionated` and
`maxxed` compact harder via the LLM reranker. So `simple` buys its accuracy partly
with bigger context blocks — relevant if the downstream prompt budget is tight.

## Axis 4 — Latency (mean ms; p95 in the cards)

- **`opinionated`** owns the costliest **ingest** (mean ~5–15 s/turn on Opus, p95 to
  ~47 s) — the per-fact parallel reconcile. Within the 60 s `/turns` budget, but heavy.
- **`maxxed`** owns the costliest **recall** (mean ~5–10 s) — LLM rerank + compaction
  in the hot path.
- **`simple`** is the latency sweet spot (recall ~0.4–1.5 s, ingest ~3–10 s).
- **`baseline`** is ~milliseconds everywhere (no LLM), at the cost of accuracy.

## The contradiction fixture — does `opinionated` earn its complexity?

`opinionated`'s headline design bet is that contradictions should be **linked, not
superseded**: keep both sides active, follow the link in recall, and narrate the
tension *and the reason* ("previously liked oranges, now apples — too acidic"). The
[`contradiction`](../bench/suite/adapters/contradiction.ts) fixture was built
specifically to reward that — 5 scenarios that force same-slot conflicts (relocation,
favorite language, diet, an opinion arc, job satisfaction), each with two probes: a
`contradiction_tension` probe (does recall surface *both* sides + the unresolved
state?) and a `control_current` probe (is the current value still right?).

Run on **Haiku**, on the post-`9bbc81c` code (reason-as-CoT + narrated link note):

| impl | accuracy | tension | control | cost | calls | recall ms |
|---|---|---|---|---|---|---|
| **simple** | **100%** | 5/5 | 5/5 | **$0.017** | **14** | **424** |
| **maxxed** | **100%** | 5/5 | 5/5 | $0.074 | 38 | 4391 |
| opinionated | 90% | **5/5** | 4/5 | $0.118 | 47 | 3337 |

**Honest verdict: the fixture does *not* demonstrate an `opinionated` advantage.**

- The reason-as-CoT change **did** fix opinionated's earlier tension miss — every
  `contradiction_tension` probe now scores a perfect 1.0, and the narration is
  qualitatively the richest (it explicitly states both sides *and* why the view
  changed). On its own design metric, the feature works.
- But opinionated still nets **90%**: on the relocation scenario its more-aggressive
  tension narration over-stated an unsettled move as "Denver finalized" and **failed
  the control probe** (0.1). It traded a tension miss for a control miss.
- **`simple` and `maxxed` both score 100%** — at 1/7 and 1/2 the cost. The reason
  the fixture can't separate them: the live LLM extractor files conflicting
  statements under *different* canonical keys, so both facts coexist as active rows
  even in the supersede-based builds; supersession never fires and they surface both
  sides anyway (just with slightly lower per-probe completeness, 0.7–0.95 vs
  opinionated's 1.0). The adapter's own docstring predicted exactly this failure mode.

So opinionated's link-graph produces the **cleanest** contradiction narration but no
**accuracy** edge over a smart extractor + a "previously X" breadcrumb — and it costs
3× more. Its value, if any, is qualitative (explicit reason in the narration), not a
measurable win on this benchmark.

## Reading — UPDATED after the discriminating runs (N=40, LoCoMo on LLM builds, adversarial)

> An earlier version of this section concluded "`simple` is the standout /
> `opinionated` has no accuracy premium." **That was an artifact of saturated,
> low-N probes.** Once we raised N and added discriminating fixtures, the picture
> changed — see the [probe-discrimination audit](research/probe-discrimination-audit.md)
> and [failure analysis](research/failure-analysis-and-action-plan.md).

- **On saturated/clustered benchmarks the builds tie.** longmemeval at N=40:
  simple 75 / opinionated 77.5 / maxxed 70 (a 7.5-pt cluster, not the
  simple-93/maxxed-73 the N=15 run implied). LoCoMo (N=100): baseline 15 → simple
  24 → maxxed 26 → opinionated 27 — all LLM builds ~10–12 pts over the floor.
- **On the adversarial set (which actually discriminates), `opinionated` wins:**
  baseline 20 → simple 63 → maxxed 70 → **opinionated 80**. Its link-following
  recall takes `multihop_decoy` 4/4, `temporal_duration` 2/2, `stale_trap` 3/3 —
  so the link-graph design **does** earn its 3–8× cost on hard reasoning. Its one
  backfire is `slot_collision` 2/3 (keep-both is wrong for a plain correction).
- **Shared weaknesses (all builds):** temporal arithmetic/ordering, full A→B→C
  history (the `prior[0]`-only breadcrumb), and multi-hop chaining for simple.
- **Haiku is a viable default** — near-Opus accuracy at ~1/15 the cost; cost
  ranking is call-count-bound, not per-token.

**Revised take:** no single build dominates. `simple` is the best cost/latency for
clustered workloads; `opinionated` is the accuracy leader on hard reasoning and
worth developing further; `maxxed` is the layer-it-on middle. Next: the
per-implementation [improvement action plan](research/failure-analysis-and-action-plan.md).

_Caveats: longmemeval N=40, ruler N=30, LoCoMo N=100, adversarial N=30 (Haiku);
Opus standard-benchmark cells remain low-N (3–6) — ranking signal only. Cost is a
list-price estimate excluding the Opus judge._
