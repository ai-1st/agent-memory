# Benchmark suite results

Generated from the benchmark suite ([`bench/suite/`](../bench/suite)) — four
benchmarks normalized to one contract and scored by an **LLM judge** (Claude Opus
4.8) on the **mem0 three-axis card**: accuracy-by-category / tokens-per-recall /
p50–p95 latency. Reproduce with `bash scripts/run-suite.sh` (raw cards land in
git-ignored `bench/results/suite/`).

**Run shape (cost-bounded, parallel).** The four implementations ran as
concurrent sequences. `baseline` (free, no LLM) ran every benchmark at full-ish N;
the LLM builds ran the *tractable* benchmarks at small N. **LoCoMo is
baseline-only** here — its full-conversation ingestion (~hundreds of turns/conv)
into a live-LLM service is a separate long batch (the adapter is ready). N (probes)
is shown next to each cell; small N ⇒ treat as a ranking signal, not a precise rate.

## ⚠️ Validity caveats (read first)

We scanned every service + run log for rate limits and errors. Findings:

- **No rate limiting.** Zero `429` / `overloaded` / `timeout` / `ECONNRESET`
  signatures across all four services; **0 judge errors** on all 13 cards. Numbers
  are not suppressed by gateway throttling, and parallelizing introduced none.
- **`opinionated` — 3× HTTP 500** (`TypeError: Cannot read properties of undefined
  (reading 'value')`). These hit `ruler-niah`: recall returned **empty** (tokens/recall
  = 0), so its **ruler-niah 33% is largely a bug artifact**, not a design result
  (only the abstention probes "passed", by returning nothing). Its real ruler score
  is unknown until fixed. Custom/longmemeval were unaffected (100%).
- **`maxxed` — 5× extraction schema-mismatch → silent rule fallback**
  (`No object generated: response did not match schema`). ~5 turns were extracted
  by the rule fallback instead of the LLM pipeline, mildly **understating** maxxed
  (most visible as `ruler-niah` multihop 0/2 and `longmemeval` 2/3).
- **`baseline` / `simple`** ran clean (no errors).

Per direction, these are **documented, not fixed** — to be addressed next.

## Axis 1 — Accuracy (judge pass rate, N = probes)

| Benchmark | baseline | opinionated | simple | maxxed |
|---|---|---|---|---|
| custom | 33% (12) | 100% (12) | 92% (12) | 100% (12) |
| longmemeval | 45% (20) | 100% (3) | 100% (3) | 67% (3) |
| locomo | 10% (20) | — | — | — |
| ruler-niah | 100% (12) | 33% (6) ⚠️bug | 100% (6) | 67% (6) ⚠️ |

Per-category notes:
- **custom:** `simple` is the only LLM build to miss `opinion_arc` (0/1); opinionated
  & maxxed 1/1 (consistent with the earlier comparison).
- **ruler-niah:** `baseline` aces it (4/4/4) — exact-token needle retrieval is easy
  for keyword match; the discrimination is at larger haystack depth. `simple` 6/6.
  `opinionated` 0/2 recall + 0/2 multihop is the 500 bug (empty context); `maxxed`
  multihop 0/2 reflects the schema-fallback turns.
- **longmemeval:** the LLM builds ran the first 3 instances (all `temporal-reasoning`);
  `baseline`'s 20 were also temporal-heavy (9/20). Small N — indicative only.
- **locomo (baseline-only):** 10% — the lexical floor collapses on realistic long
  multi-session QA (temporal 0/10, recall 0/2, multihop 2/8). This is the headline
  argument for the LLM builds; running them on LoCoMo is the priority next step.

## Axis 2 — Tokens per recall (context size returned)

| Benchmark | baseline | opinionated | simple | maxxed |
|---|---|---|---|---|
| custom | 9 | 40 | 39 | 31 |
| longmemeval | 173 | 131 | 555 | 348 |
| ruler-niah | 76 | 0 ⚠️ | 164 | 50 |

All builds stay compact (tens–hundreds of tokens). `simple` returns the most on
longmemeval (555) — it leans on dumping more context; `maxxed`/`opinionated` compact
harder. `opinionated`'s 0 on ruler is the empty-recall bug.

## Axis 3 — Latency (mean ms, p95 in parens)

| Benchmark × impl | recall ms | ingest ms |
|---|---|---|
| custom × baseline | 4 (17) | 2 (10) |
| custom × opinionated | 3712 (5353) | **15784 (41831)** |
| custom × simple | 517 (1082) | 4152 (7056) |
| custom × maxxed | **9084 (41004)** | 5663 (9935) |
| longmemeval × simple | 1511 (1958) | 11612 (14847) |
| longmemeval × opinionated | 6181 (7361) | **24014 (47354)** |
| longmemeval × maxxed | 8322 (9791) | 10696 (13442) |
| ruler-niah × simple | 1321 (1803) | 3518 (6863) |
| ruler-niah × maxxed | 6963 (9453) | 3271 (6359) |
| (all baseline) | ~3–7 | ~0–2 |

- **opinionated** owns the costliest **ingest** (mean ~16–24 s/turn, p95 up to ~47 s)
  — the per-fact parallel reconcile. Within the 60 s `/turns` budget, but heavy.
- **maxxed** owns the costliest **recall** (mean ~7–9 s, p95 up to ~41 s) — LLM
  rerank + compaction in the hot path.
- **simple** is the latency sweet spot (recall ~0.5–1.5 s, ingest ~4–12 s).
- **baseline** is ~milliseconds everywhere (no LLM) at the cost of accuracy.

## Reading

On the bounded subset, **simple** and **maxxed** lead on accuracy with very
different cost shapes (simple cheap-recall, maxxed cheap-ingest/expensive-recall);
**opinionated** matches them on custom/longmemeval but its 500 bug invalidates its
ruler number and it has the heaviest ingest. The **baseline floor is genuinely low
on realistic data** (LoCoMo 10%, LongMemEval 45%), which is the whole point of the
LLM builds. Numbers are bounded-N and confounded by the two documented bugs — a
clean re-run (bugs fixed, LoCoMo on the LLM builds, larger N) is the next step.
