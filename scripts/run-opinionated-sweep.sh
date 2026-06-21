#!/usr/bin/env bash
# A/B sweep for opinionated recall/extraction levers on LoCoMo (Haiku, N=100).
# Four configs run concurrently, each its own server/port/data-dir/flags/label:
#   8091 base   (Lever-2 default)            -> locomo__opinionated-l2.json
#   8092 +mq    (MEMORY_MULTI_QUERY=1)       -> locomo__opinionated-mq.json
#   8093 +chunk (MEMORY_CHUNK_EXTRACT=1)     -> locomo__opinionated-chunk.json
#   8094 +both  (mq + chunk)                 -> locomo__opinionated-both.json
#
# Port-safe: refuses if any port busy, kills only its own ports on exit.
#   bash scripts/run-opinionated-sweep.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
set -a; [ -f .env ] && . ./.env; set +a
MODEL="${MEMORY_LLM_MODEL:-claude-haiku-4-5-20251001}"; export MEMORY_LLM_MODEL="$MODEL"
N="${LOCOMO_N:-100}"
PORTS="8091 8092 8093 8094"
DATA=/tmp/opinionated-sweep; rm -rf "$DATA"; mkdir -p "$DATA"
mkdir -p "$REPO/logs"; export SUITE_JUDGE_LOG="$REPO/logs/judge-llm.csv"

for p in $PORTS; do
  if lsof -ti "tcp:$p" >/dev/null 2>&1; then echo "ERROR: port $p in use; aborting."; exit 1; fi
done
PIDS=""
kill_ports() { for p in $PORTS; do lsof -ti "tcp:$p" 2>/dev/null | xargs kill 2>/dev/null || true; done; }
trap 'kill_ports; for p in $PIDS; do kill "$p" 2>/dev/null || true; done' EXIT

start() { # name port mq chunk
  local name="$1" port="$2" mq="$3" chunk="$4" attempt pid i
  for attempt in 1 2 3; do
    ( cd "$REPO" && env MEMORY_DATA_DIR="$DATA/$name" MEMORY_LLM=live \
        MEMORY_LLM_MODEL="$MODEL" MEMORY_MULTI_QUERY="$mq" MEMORY_CHUNK_EXTRACT="$chunk" \
        MEMORY_LLM_LOG="$REPO/logs/opinionated-$name-llm.csv" PORT="$port" npm start \
        >"/tmp/sweep-srv-$name.log" 2>&1 ) &
    pid=$!
    for i in $(seq 1 60); do
      curl -sf "http://localhost:$port/health" >/dev/null 2>&1 && { echo "$name up :$port"; PIDS="$PIDS $pid"; return 0; }
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill "$pid" 2>/dev/null || true; echo "$name retry $attempt"
  done
  echo "WARN: $name failed to start"; return 1
}

probe() { # label port
  local label="$1" port="$2"
  echo "[$label] START locomo (N=$N)"
  npx tsx bench/suite/run.ts --adapter locomo --url "http://localhost:$port" --label "opinionated-$label" --limit "$N" \
    >"/tmp/sweep-$label.log" 2>&1 || echo "[$label] FAILED"
  local acc; acc=$(grep -m1 '"accuracy"' "bench/results/suite/locomo__opinionated-$label.json" 2>/dev/null | tr -d ' ,')
  echo "[$label] DONE -> ${acc:-no-card}"
}

start base  8091 "" ""   || true
start mq    8092 1  ""   || true
start chunk 8093 "" 1    || true
start both  8094 1  1    || true

seqs=""
probe l2    8091 & seqs="$seqs $!"
probe mq    8092 & seqs="$seqs $!"
probe chunk 8093 & seqs="$seqs $!"
probe both  8094 & seqs="$seqs $!"
wait $seqs
echo "=== SWEEP DONE ==="
