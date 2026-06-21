#!/usr/bin/env bash
# Run vanilla mem0+Chroma across our whole bench suite. Fresh server + data dir
# per adapter. Same N/model/judge as our builds for a fair stack-rank.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
set -a; [ -f "$REPO/.env" ] && . "$REPO/.env"; set +a
export SUITE_JUDGE_LOG="$REPO/logs/judge-mem0c.csv"
PORT=8095
start_server() {
  lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null || true; sleep 1; rm -rf "$1"
  ( cd "$HERE" && MEMORY_DATA_DIR="$1" "$HERE/.venv/bin/uvicorn" src.app:app \
      --host 0.0.0.0 --port "$PORT" --app-dir "$HERE" >"/tmp/mem0c-srv.log" 2>&1 ) &
  for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "server failed"; return 1
}
run_adapter() {
  local adapter="$1" limit="$2" hay="${3:-12}"
  start_server "$HERE/data/suite_$adapter" || { echo "[$adapter] SERVER FAIL"; return; }
  echo "[$adapter] running N=$limit"
  ( cd "$REPO" && RULER_HAYSTACK="$hay" npx tsx bench/suite/run.ts \
      --adapter "$adapter" --url "http://localhost:$PORT" --label mem0-chroma --limit "$limit" \
      >"/tmp/mem0c-$adapter.log" 2>&1 ) || echo "[$adapter] RUN FAIL"
  local acc; acc=$(grep -m1 '"accuracy"' "$REPO/bench/results/suite/${adapter}__mem0-chroma.json" 2>/dev/null | tr -d ' ,')
  echo "[$adapter] DONE -> ${acc:-no-card}"
}
run_adapter custom        12
run_adapter contradiction 10
run_adapter adversarial   30
run_adapter ruler-niah    30 12
run_adapter longmemeval   40
run_adapter locomo        100
lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
echo "=== MEM0-CHROMA SUITE DONE ==="
