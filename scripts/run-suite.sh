#!/usr/bin/env bash
# Run the benchmark suite (LongMemEval / LoCoMo / RULER-NIAH / custom) across all
# four implementations and write a three-axis card per (adapter, impl) to
# bench/results/suite/<adapter>__<impl>.json.
#
# PARALLEL: the four implementations run as concurrent sequences (each ingests +
# probes its own service), so wall-clock collapses to roughly the slowest build
# instead of the sum. The shared cost is LLM-gateway concurrency.
#
# Cost-bounded: baseline (free) runs every benchmark at full-ish N; the LLM builds
# run the tractable benchmarks at small N. LoCoMo is baseline-only here (its
# full-conversation ingestion into a live-LLM service is a separate long batch).
#
#   bash scripts/run-suite.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
set -a; [ -f .env ] && . ./.env; set +a

DATA=/tmp/suite-run; rm -rf "$DATA"; mkdir -p "$DATA"
pkill -f "tsx src/server.ts" 2>/dev/null || true
sleep 1

PIDS=()
start() { local name="$1" dir="$2" port="$3"; shift 3
  ( cd "$dir" && env "$@" PORT="$port" npm start >"/tmp/suite-srv-$name.log" 2>&1 ) & PIDS+=("$!")
  echo "started $name on :$port"; }
start baseline    "$REPO"                              8080 MEMORY_DB_PATH="$DATA/baseline.sqlite"
start opinionated "$REPO/implementations/opinionated"  8091 MEMORY_DATA_DIR="$DATA/opinionated" MEMORY_LLM=live
start simple      "$REPO/implementations/simple"       8092 MEMORY_DATA_DIR="$DATA/simple"
start maxxed      "$REPO/implementations/maxxed"       8093 MEMORY_DB_DIR="$DATA/maxxed" MEMORY_PIPELINE=llm
trap 'pkill -f "tsx src/server.ts" 2>/dev/null || true; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done' EXIT

for pair in baseline:8080 opinionated:8091 simple:8092 maxxed:8093; do
  name="${pair%:*}"; port="${pair#*:}"
  for i in $(seq 1 90); do curl -sf "http://localhost:$port/health" >/dev/null 2>&1 && { echo "$name healthy"; break; }; sleep 1; done
done

run() { # impl url adapter limit [haystack]
  local impl="$1" url="$2" adapter="$3" limit="$4" hay="${5:-50}"
  echo "[$impl] START $adapter (limit $limit)"
  RULER_HAYSTACK="$hay" npx tsx bench/suite/run.ts --adapter "$adapter" --url "$url" --label "$impl" --limit "$limit" \
    >"/tmp/suite-$impl-$adapter.log" 2>&1 || echo "[$impl] $adapter FAILED"
  local card="bench/results/suite/${adapter}__${impl}.json"
  local acc; acc=$(grep -m1 '"accuracy"' "$card" 2>/dev/null | tr -d ' ,' || true)
  echo "[$impl] DONE $adapter -> ${acc:-no-card}"
}

seq_baseline() {
  run baseline http://localhost:8080 custom      20
  run baseline http://localhost:8080 longmemeval 20
  run baseline http://localhost:8080 locomo      20
  run baseline http://localhost:8080 ruler-niah  12 40
}
seq_llm() { # impl port
  local impl="$1" url="http://localhost:$2"
  run "$impl" "$url" custom      12
  run "$impl" "$url" longmemeval 3
  run "$impl" "$url" ruler-niah  6 12
}

# Four concurrent sequences. Wait only on these PIDs — a bare `wait` would also
# block on the never-exiting server jobs started above.
seqs=()
seq_baseline & seqs+=("$!")
seq_llm opinionated 8091 & seqs+=("$!")
seq_llm simple 8092 & seqs+=("$!")
seq_llm maxxed 8093 & seqs+=("$!")
wait "${seqs[@]}"

echo "=== SUITE DONE ==="
