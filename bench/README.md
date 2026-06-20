# Benchmark harness

HTTP-only benchmark runner for comparing memory-service implementations/branches
against each other. It talks to a running service over the contract endpoints, so
it does not care how the service is built (TS or otherwise).

## Run

```bash
# service running on :8080
npm run bench -- --label baseline

# a branch/variant on another port or host
MEMORY_BASE=http://localhost:8081 npm run bench -- --label maxxed

# compare every saved run
npm run bench -- --compare
```

Results are written to `bench/results/<label>.json` and summarised as a table.
`bench/results/` is git-ignored (local benchmarking artifacts).

## Scenario format

Same shape as the self-eval fixtures ([`../fixtures/basic.json`](../fixtures/basic.json)):
scenarios of scripted `turns` (ingested via `/turns`) and `probes` run against
`/recall`. Each probe asserts one of:

- `expect_any`: at least one substring appears in the recalled context
- `expect_all`: all substrings appear
- `expect_empty`: context is empty (noise / cold-start resistance)

Point `--scenario` at any such file to benchmark a different dataset.

## Metrics

- **recall quality** — fraction of probes whose expectation held (primary signal)
- **avg ingest ms** — mean `/turns` latency (extraction + persistence)
- **avg recall ms** — mean `/recall` latency

## Workflow

This is the iteration loop: change a pipeline, re-run with a new `--label`, then
`--compare` to see whether the number moved. Record meaningful jumps in
[`../CHANGELOG.md`](../CHANGELOG.md).

## Comparison report (all four)

The four implementations live as folders — the baseline at the repo root plus
`implementations/{opinionated,simple,maxxed}`. To run the **same** harder benchmark
([`scenarios/comparison.json`](scenarios/comparison.json)) against all of them and
check each against the assignment's formal requirements — scored by an LLM judge
(Claude Opus 4.8) — from the repo root:

```bash
bash scripts/run-comparison.sh   # boots all four, runs bench/report.ts, tears down
```

It writes the raw `bench/results/REPORT.md` + `report.json` (git-ignored); the
curated snapshot with the written analysis is committed at
[`../docs/COMPARISON.md`](../docs/COMPARISON.md). `bench/report.ts` can also be run
standalone against already-running services (see its header).
