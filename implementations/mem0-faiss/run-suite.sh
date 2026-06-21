#!/usr/bin/env bash
# Run vanilla mem0+FAISS across the rest of our bench adapters (LoCoMo done
# separately). Fresh server + data dir per adapter so mem0's FAISS-flat churn
# doesn't bleed across runs. Same N as our builds for a fair stack-rank.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
set -a; [ -f "$REPO/.env" ] && . "$REPO/.env"; set +a
export SUITE_JUDGE_LOG="$REPO/logs/judge-mem0.csv"
PORT=8095

start_server() { # data_dir
  lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1
  rm -rf "$1"
  ( cd "$HERE" && MEMORY_DATA_DIR="$1" "$HERE/.venv/bin/uvicorn" src.app:app \
      --host 0.0.0.0 --port "$PORT" --app-dir "$HERE" >"/tmp/mem0-srv.log" 2>&1 ) &
  for i in $(seq 1 40); do
    curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server failed to start"; return 1
}

run_adapter() { # adapter limit [haystack]
  local adapter="$1" limit="$2" hay="${3:-12}"
  echo "[$adapter] starting fresh server…"
  start_server "$HERE/data/suite_$adapter" || { echo "[$adapter] SERVER FAIL"; return; }
  echo "[$adapter] running N=$limit"
  ( cd "$REPO" && RULER_HAYSTACK="$hay" npx tsx bench/suite/run.ts \
      --adapter "$adapter" --url "http://localhost:$PORT" --label mem0-faiss --limit "$limit" \
      >"/tmp/mem0-$adapter.log" 2>&1 ) || echo "[$adapter] RUN FAIL"
  local acc; acc=$(grep -m1 '"accuracy"' "$REPO/bench/results/suite/${adapter}__mem0-faiss.json" 2>/dev/null | tr -d ' ,')
  echo "[$adapter] DONE -> ${acc:-no-card}"
}

run_adapter custom        12
run_adapter contradiction 10
run_adapter adversarial   30
run_adapter ruler-niah    30 12
run_adapter longmemeval   40
lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
echo "=== MEM0 SUITE DONE ==="
