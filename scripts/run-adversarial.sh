#!/usr/bin/env bash
# Run the adversarial (discriminating) probe set against all four implementations
# and write bench/results/suite/adversarial__<impl>.json each.
#
# Uses the resumable runner (--resume), Haiku for the LLM builds, baseline (free)
# for the floor. Port-safe: refuses to start if a target port is busy (a LoCoMo
# run may still hold 8091-8093) and kills ONLY its own ports on exit.
#
#   bash scripts/run-adversarial.sh                # fresh
#   RESUME=1 bash scripts/run-adversarial.sh       # resume a killed run
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
set -a; [ -f .env ] && . ./.env; set +a

MODEL="${MEMORY_LLM_MODEL:-claude-haiku-4-5-20251001}"
export MEMORY_LLM_MODEL="$MODEL"
RESUME_FLAG=""; [ "${RESUME:-0}" = "1" ] && RESUME_FLAG="--resume"
LIMIT="${ADV_LIMIT:-30}"
PORTS=(8080 8091 8092 8093)
DATA=/tmp/adversarial-run
[ "${RESUME:-0}" = "1" ] || { rm -rf "$DATA"; mkdir -p "$DATA"; }
mkdir -p "$DATA" "$REPO/logs"
export SUITE_JUDGE_LOG="$REPO/logs/judge-llm.csv"

for p in "${PORTS[@]}"; do
  if lsof -ti "tcp:$p" >/dev/null 2>&1; then
    echo "ERROR: port $p in use; aborting (will not kill it). Free it first (LoCoMo run?)."; exit 1
  fi
done

PIDS=()
kill_ports() { for p in "${PORTS[@]}"; do lsof -ti "tcp:$p" 2>/dev/null | xargs kill 2>/dev/null || true; done; }
trap 'kill_ports; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done' EXIT

ensure_up() { # name dir port env...
  local name="$1" dir="$2" port="$3"; shift 3
  local attempt pid i
  for attempt in 1 2 3; do
    ( cd "$dir" && env "$@" PORT="$port" npm start >"/tmp/adversarial-srv-$name.log" 2>&1 ) &
    pid=$!
    for i in $(seq 1 60); do
      if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then
        echo "$name healthy on :$port (attempt $attempt)"; PIDS+=("$pid"); return 0
      fi
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill "$pid" 2>/dev/null || true
    echo "$name not healthy (attempt $attempt); retrying"
  done
  echo "WARN: $name FAILED to start; last log:"; tail -12 "/tmp/adversarial-srv-$name.log"; return 1
}

echo "model=$MODEL judge=${SUITE_JUDGE_MODEL:-claude-opus-4-8} limit=$LIMIT resume=${RESUME:-0}"
ensure_up baseline    "$REPO"                              8080 MEMORY_DB_PATH="$DATA/baseline.sqlite"
ensure_up opinionated "$REPO/implementations/opinionated"  8091 MEMORY_DATA_DIR="$DATA/opinionated" MEMORY_LLM=live MEMORY_LLM_MODEL="$MODEL" MEMORY_LLM_LOG="$REPO/logs/opinionated-llm.csv"
ensure_up simple      "$REPO/implementations/simple"       8092 MEMORY_DATA_DIR="$DATA/simple" MEMORY_LLM_MODEL="$MODEL" MEMORY_LLM_LOG="$REPO/logs/simple-llm.csv"
ensure_up maxxed      "$REPO/implementations/maxxed"       8093 MEMORY_DB_DIR="$DATA/maxxed" MEMORY_PIPELINE=llm MEMORY_LLM_MODEL="$MODEL" MEMORY_LLM_LOG="$REPO/logs/maxxed-llm.csv"

run() { # impl port
  local impl="$1" url="http://localhost:$2"
  echo "[$impl] START adversarial"
  npx tsx bench/suite/run.ts --adapter adversarial --url "$url" --label "$impl" --limit "$LIMIT" $RESUME_FLAG \
    >"/tmp/adversarial-$impl.log" 2>&1 || echo "[$impl] FAILED"
  local card="bench/results/suite/adversarial__${impl}.json"
  local acc; acc=$(grep -m1 '"accuracy"' "$card" 2>/dev/null | tr -d ' ,' || true)
  echo "[$impl] DONE -> ${acc:-no-card}"
}

seqs=()
run baseline    8080 & seqs+=("$!")
run opinionated 8091 & seqs+=("$!")
run simple      8092 & seqs+=("$!")
run maxxed      8093 & seqs+=("$!")
wait "${seqs[@]}"

echo "=== ADVERSARIAL DONE ==="
