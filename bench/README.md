# Benchmark harness

HTTP-only benchmark runner for comparing memory-service implementations/variants
against each other. It talks to a running service over the contract endpoints, so
it does not care how the service is built.

## Run

```bash
# service running on :8080
python bench/harness.py --label baseline

# a variant on another port / host
MEMORY_BASE=http://localhost:8081 python bench/harness.py --label llm-extract

# compare every saved run
python bench/harness.py --compare
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

This is the iteration loop: change a pipeline, re-run with a new `--label`, and
`--compare` to see whether the number moved. Record meaningful jumps in
[`../CHANGELOG.md`](../CHANGELOG.md).
