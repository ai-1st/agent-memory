#!/usr/bin/env bash
# Start the mem0+FAISS service locally for the bench. Sources keys from the repo .env.
set -uo pipefail
cd "$(dirname "$0")"
set -a; [ -f ../../.env ] && . ../../.env; set +a
export MEMORY_DATA_DIR="${MEMORY_DATA_DIR:-$PWD/data/faiss}"
export PORT="${PORT:-8095}"
exec .venv/bin/uvicorn src.app:app --host 0.0.0.0 --port "$PORT" --app-dir .
