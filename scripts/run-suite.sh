#!/usr/bin/env bash
# Run the benchmark suite (LongMemEval / LoCoMo / RULER-NIAH / custom) across all
# four implementations and write a three-axis (+cost) card per (adapter, impl) to
# bench/results/suite/<adapter>__<impl>.json.
#
# PARALLEL: the four implementations run as concurrent sequences. Cost-bounded:
# baseline (free) runs every benchmark at full-ish N; the LLM builds run the
# tractable benchmarks at small N. LoCoMo is baseline-only here (its
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

# Per-call LLM/embedding CSV logs (gitignored logs/). Fresh per run.
mkdir -p "$REPO/logs"; rm -f "$REPO"/logs/*-llm.csv 2>/dev/null || true
export SUITE_JUDGE_LOG="$REPO/logs/judge-llm.csv"

PIDS=()
# Start a service and wait for health, retrying if it dies on init (pglite WASM
# init is intermittently flaky under tsx and recovers on a restart).
ensure_up() { # name dir port env...
  local name="$1" dir="$2" port="$3"; shift 3
  local attempt pid i
  for attempt in 1 2 3; do
    ( cd "$dir" && env "$@" PORT="$port" npm start >"/tmp/suite-srv-$name.log" 2>&1 ) &
    pid=$!
    for i in $(seq 1 60); do
      if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then
        echo "$name healthy on :$port (attempt $attempt)"; PIDS+=("$pid"); return 0
      fi
      kill -0 "$pid" 2>/dev/null || break   # process died -> retry
      sleep 1
    done
    kill "$pid" 2>/dev/null || true
    echo "$name not healthy (attempt $attempt); retrying"
  done
  echo "WARN: $name FAILED to start after retries; last log:"; tail -12 "/tmp/suite-srv-$name.log"
}
trap 'pkill -f "tsx src/server.ts" 2>/dev/null || true; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done' EXIT

# LLM model is a container parameter (default Opus); set MEMORY_LLM_MODEL to switch
# (e.g. claude-haiku-4-5-20251001 for a cheap run). Baseline uses no LLM.
MODEL="${MEMORY_LLM_MODEL:-claude-opus-4-8}"
ensure_up baseline    "$REPO"                              8080 MEMORY_DB_PATH="$DATA/baseline.sqlite"
ensure_up opinionated "$REPO/implementations/opinionated"  8091 MEMORY_DATA_DIR="$DATA/opinionated" MEMORY_LLM=live MEMORY_LLM_MODEL="$MODEL" MEMORY_LLM_LOG="$REPO/logs/opinionated-llm.csv"
ensure_up simple      "$REPO/implementations/simple"       8092 MEMORY_DATA_DIR="$DATA/simple" MEMORY_LLM_MODEL="$MODEL" MEMORY_LLM_LOG="$REPO/logs/simple-llm.csv"
ensure_up maxxed      "$REPO/implementations/maxxed"       8093 MEMORY_DB_DIR="$DATA/maxxed" MEMORY_PIPELINE=llm MEMORY_LLM_MODEL="$MODEL" MEMORY_LLM_LOG="$REPO/logs/maxxed-llm.csv"

# Probe limits — env-overridable for scaled runs (e.g. 5x). custom has only 12 probes.
CUSTOM_LIM="${CUSTOM_LIM:-12}"; LME_LIM="${LME_LIM:-3}"; RULER_LIM="${RULER_LIM:-6}"; RULER_HAY="${RULER_HAY:-12}"
BASE_CUSTOM="${BASE_CUSTOM:-20}"; BASE_LME="${BASE_LME:-20}"; BASE_LOCOMO="${BASE_LOCOMO:-20}"; BASE_RULER="${BASE_RULER:-12}"; BASE_RULER_HAY="${BASE_RULER_HAY:-40}"
echo "model=$MODEL judge=${SUITE_JUDGE_MODEL:-claude-opus-4-8}  llm-limits: custom=$CUSTOM_LIM lme=$LME_LIM ruler=$RULER_LIM"

run() { # impl url adapter limit [haystack]
  local impl="$1" url="$2" adapter="$3" limit="$4" hay="${5:-50}"
  echo "[$impl] START $adapter (limit $limit)"
  RULER_HAYSTACK="$hay" npx tsx bench/suite/run.ts --adapter "$adapter" --url "$url" --label "$impl" --limit "$limit" \
    >"/tmp/suite-$impl-$adapter.log" 2>&1 || echo "[$impl] $adapter FAILED"
  local card="bench/results/suite/${adapter}__${impl}.json"
  local acc; acc=$(grep -m1 '"accuracy"' "$card" 2>/dev/null | tr -d ' ,' || true)
  local usd; usd=$(grep -m1 '"est_usd"' "$card" 2>/dev/null | tr -d ' ,' || true)
  echo "[$impl] DONE $adapter -> ${acc:-no-card} ${usd:-}"
}

seq_baseline() {
  run baseline http://localhost:8080 custom      "$BASE_CUSTOM"
  run baseline http://localhost:8080 longmemeval "$BASE_LME"
  run baseline http://localhost:8080 locomo      "$BASE_LOCOMO"
  run baseline http://localhost:8080 ruler-niah  "$BASE_RULER" "$BASE_RULER_HAY"
}
seq_llm() { # impl port
  local impl="$1" url="http://localhost:$2"
  run "$impl" "$url" custom      "$CUSTOM_LIM"
  run "$impl" "$url" longmemeval "$LME_LIM"
  run "$impl" "$url" ruler-niah  "$RULER_LIM" "$RULER_HAY"
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
