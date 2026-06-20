#!/usr/bin/env bash
# Minimal HTTP smoke test (the assignment's §7 smoke) against a running service.
# Usage: PORT=8093 bash scripts/smoke.sh   (default port 8093)
set -euo pipefail
PORT="${PORT:-8093}"
BASE="http://localhost:${PORT}"

echo "== health =="
curl -sf "${BASE}/health" | (command -v jq >/dev/null && jq . || cat)

echo "== write a turn =="
curl -s -X POST "${BASE}/turns" \
  -H 'Content-Type: application/json' \
  -d '{
    "session_id": "smoke-1",
    "user_id": "smoke-user",
    "messages": [
      {"role": "user", "content": "I just moved to Berlin from NYC last month. Loving it so far."},
      {"role": "assistant", "content": "That sounds exciting! How are you settling in?"}
    ],
    "timestamp": "2025-03-15T10:30:00Z",
    "metadata": {}
  }' | (command -v jq >/dev/null && jq . || cat)

echo "== recall (cross-session) =="
curl -s -X POST "${BASE}/recall" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "Where does this user live?",
    "session_id": "smoke-2",
    "user_id": "smoke-user",
    "max_tokens": 512
  }' | (command -v jq >/dev/null && jq . || cat)

echo "== memories =="
curl -s "${BASE}/users/smoke-user/memories" | (command -v jq >/dev/null && jq . || cat)

echo "== cleanup =="
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE "${BASE}/users/smoke-user"
echo "smoke OK"
