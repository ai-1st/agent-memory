#!/usr/bin/env bash
# Smoke test from §7 of the assignment — verify the running service is
# compatible with the eval harness. Run after `docker compose up`.
#
#   ./scripts/smoke.sh            # targets http://localhost:8080
#   BASE=http://localhost:8081 ./scripts/smoke.sh
set -euo pipefail
BASE="${BASE:-http://localhost:8080}"
jq() { command jq "$@" 2>/dev/null || cat; }  # jq optional

echo "== health =="
curl -sf "$BASE/health" | jq .

echo "== write turn =="
curl -s -X POST "$BASE/turns" \
  -H 'Content-Type: application/json' \
  -d '{
    "session_id": "smoke-1",
    "user_id": "user-1",
    "messages": [
      {"role": "user", "content": "I just moved to Berlin from NYC last month. Loving it so far."},
      {"role": "assistant", "content": "That sounds exciting! Berlin is a great city. How are you settling in?"}
    ],
    "timestamp": "2025-03-15T10:30:00Z",
    "metadata": {}
  }' | jq .

echo "== recall (should mention Berlin, ideally the move from NYC) =="
curl -s -X POST "$BASE/recall" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "Where does this user live?",
    "session_id": "smoke-2",
    "user_id": "user-1",
    "max_tokens": 512
  }' | jq .

echo "== memories (should be structured, not raw message text) =="
curl -s "$BASE/users/user-1/memories" | jq .

echo "== smoke complete =="
