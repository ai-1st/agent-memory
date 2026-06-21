#!/usr/bin/env bash
# Bring up all four implementations on distinct ports (LLM builds in live mode,
# keys from the gitignored root .env), run the LLM-judged comparison report, then
# tear everything down. Writes bench/results/REPORT.md.
#
#   bash scripts/run-comparison.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Load API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY) from the gitignored .env.
set -a; [ -f .env ] && . ./.env; set +a

DATA=/tmp/cmp-run
rm -rf "$DATA"; mkdir -p "$DATA"

# Clear any stale dev servers.
pkill -f "tsx src/server.ts" 2>/dev/null || true
sleep 1

PIDS=()
start() { # name dir port env...
  local name="$1" dir="$2" port="$3"; shift 3
  ( cd "$dir" && env "$@" PORT="$port" npm start >"/tmp/cmp-$name.log" 2>&1 ) &
  PIDS+=("$!")
  echo "started $name on :$port"
}

start baseline    "$REPO/implementations/baseline"                              8080 MEMORY_DB_PATH="$DATA/baseline.sqlite"
start opinionated "$REPO"  8091 MEMORY_DATA_DIR="$DATA/opinionated" MEMORY_LLM=live
start simple      "$REPO/implementations/simple"       8092 MEMORY_DATA_DIR="$DATA/simple"
start maxxed      "$REPO/implementations/maxxed"       8093 MEMORY_DB_DIR="$DATA/maxxed" MEMORY_PIPELINE=llm

cleanup() {
  echo "stopping services…"
  pkill -f "tsx src/server.ts" 2>/dev/null || true
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

# Wait for health.
for pair in baseline:8080 opinionated:8091 simple:8092 maxxed:8093; do
  name="${pair%:*}"; port="${pair#*:}"
  ok=0
  for i in $(seq 1 90); do
    if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then echo "$name healthy on :$port"; ok=1; break; fi
    sleep 1
  done
  [ "$ok" = 1 ] || { echo "WARN: $name did not become healthy; last log:"; tail -15 "/tmp/cmp-$name.log"; }
done

echo "=== running LLM-judged report ==="
URL_BASELINE=http://localhost:8080 \
URL_OPINIONATED=http://localhost:8091 \
URL_SIMPLE=http://localhost:8092 \
URL_MAXXED=http://localhost:8093 \
npx tsx bench/report.ts

echo "=== done; REPORT.md written ==="
