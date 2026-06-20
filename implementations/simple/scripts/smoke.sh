#!/usr/bin/env bash
# Minimal end-to-end smoke against a running service (the assignment's §6 script).
# Usage:  BASE=http://localhost:8092 bash scripts/smoke.sh
set -euo pipefail

BASE="${BASE:-http://localhost:8092}"
echo "== smoke against ${BASE} =="

echo "-- /health"
curl -sf "${BASE}/health" && echo

echo "-- POST /turns"
curl -s -X POST "${BASE}/turns" \
  -H 'Content-Type: application/json' \
  -d '{
    "session_id": "smoke-1",
    "user_id": "smoke-user",
    "messages": [
      {"role": "user", "content": "I just moved to Berlin from NYC last month. Loving it so far."},
      {"role": "assistant", "content": "That sounds exciting! Berlin is a great city. How are you settling in?"}
    ],
    "timestamp": "2026-03-15T10:30:00Z",
    "metadata": {}
  }' && echo

echo "-- POST /recall (cross-session: should mention Berlin)"
curl -s -X POST "${BASE}/recall" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "Where does this user live?",
    "session_id": "smoke-2",
    "user_id": "smoke-user",
    "max_tokens": 512
  }' && echo

echo "-- GET /users/smoke-user/memories (should be structured, not raw text)"
curl -s "${BASE}/users/smoke-user/memories" && echo

echo "== smoke done =="
