#!/usr/bin/env bash
# Hardening run (audit follow-up): raise N on the LLM builds for statistical power
# and finally run LoCoMo against the LLM builds (was baseline-only at 15%).
#
# Haiku, LLM builds only (baseline cards already exist at >= these N). Per build,
# concurrent across builds: longmemeval(N) and ruler(N) first (the quick N-raise,
# lands early), then LoCoMo (the long batch). Cards use the -haiku label so the
# higher-N cards supersede the prior haiku cards; locomo__<impl>-haiku is new.
#
# Port-safe: starts ONLY 8091/8092/8093, refuses if busy, kills ONLY its own
# ports on exit (never a broad pkill).
#
#   bash scripts/run-hardening.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
set -a; [ -f .env ] && . ./.env; set +a

MODEL="${MEMORY_LLM_MODEL:-claude-haiku-4-5-20251001}"
export MEMORY_LLM_MODEL="$MODEL"           # so run.ts prices at the right model
LME_N="${LME_N:-40}"; RULER_N="${RULER_N:-50}"; RULER_HAY="${RULER_HAY:-12}"; LOCOMO_N="${LOCOMO_N:-100}"
PORTS=(8091 8092 8093)
DATA=/tmp/hardening-run; rm -rf "$DATA"; mkdir -p "$DATA"
mkdir -p "$REPO/logs"
export SUITE_JUDGE_LOG="$REPO/logs/judge-llm.csv"

for p in "${PORTS[@]}"; do
  if lsof -ti "tcp:$p" >/dev/null 2>&1; then
    echo "ERROR: port $p in use; aborting (will not kill it)."; exit 1
  fi
done

PIDS=()
kill_ports() { for p in "${PORTS[@]}"; do lsof -ti "tcp:$p" 2>/dev/null | xargs kill 2>/dev/null || true; done; }
trap 'kill_ports; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done' EXIT

ensure_up() { # name dir port env...
  local name="$1" dir="$2" port="$3"; shift 3
  local attempt pid i
  for attempt in 1 2 3; do
    ( cd "$dir" && env "$@" PORT="$port" npm start >"/tmp/hardening-srv-$name.log" 2>&1 ) &
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
  echo "WARN: $name FAILED to start; last log:"; tail -12 "/tmp/hardening-srv-$name.log"; return 1
}

echo "model=$MODEL judge=${SUITE_JUDGE_MODEL:-claude-opus-4-8}  N: lme=$LME_N ruler=$RULER_N(hay=$RULER_HAY) locomo=$LOCOMO_N"
ensure_up opinionated "$REPO" 8091 MEMORY_DATA_DIR="$DATA/opinionated" MEMORY_LLM=live MEMORY_LLM_MODEL="$MODEL" MEMORY_MULTI_QUERY="${MEMORY_MULTI_QUERY:-}" MEMORY_LLM_LOG="$REPO/logs/opinionated-llm.csv"
ensure_up simple      "$REPO/implementations/simple"      8092 MEMORY_DATA_DIR="$DATA/simple" MEMORY_LLM_MODEL="$MODEL" MEMORY_LLM_LOG="$REPO/logs/simple-llm.csv"
ensure_up maxxed      "$REPO/implementations/maxxed"      8093 MEMORY_DB_DIR="$DATA/maxxed" MEMORY_PIPELINE=llm MEMORY_LLM_MODEL="$MODEL" MEMORY_LLM_LOG="$REPO/logs/maxxed-llm.csv"

run() { # impl port adapter limit [haystack]
  local impl="$1" url="http://localhost:$2" adapter="$3" limit="$4" hay="${5:-50}"
  local label="${impl}-haiku${LABEL_SUFFIX:-}"
  echo "[$impl] START $adapter (N=$limit) label=$label"
  RULER_HAYSTACK="$hay" npx tsx bench/suite/run.ts --adapter "$adapter" --url "$url" --label "$label" --limit "$limit" \
    >"/tmp/hardening-$impl-$adapter.log" 2>&1 || echo "[$impl] $adapter FAILED"
  local card="bench/results/suite/${adapter}__${label}.json"
  local acc; acc=$(grep -m1 '"accuracy"' "$card" 2>/dev/null | tr -d ' ,' || true)
  local us;  us=$(grep -m1 '"est_usd"' "$card" 2>/dev/null | tr -d ' ,' || true)
  echo "[$impl] DONE $adapter -> ${acc:-no-card} ${us:-}"
}

# Which adapters to run, in order (override with ADAPTERS env). N-raise adapters
# land early; locomo is the long tail. Default = the full hardening sequence.
ADAPTERS="${ADAPTERS:-longmemeval ruler-niah locomo}"
seq_build() { # impl port
  local impl="$1" port="$2" a
  for a in $ADAPTERS; do
    case "$a" in
      longmemeval) run "$impl" "$port" longmemeval "$LME_N" ;;
      ruler-niah)  run "$impl" "$port" ruler-niah  "$RULER_N" "$RULER_HAY" ;;
      locomo)      run "$impl" "$port" locomo      "$LOCOMO_N" ;;
    esac
  done
}

# Which builds to run (override with IMPLS env, space-separated). Default all 3.
# Portable port lookup (macOS ships bash 3.2 — no associative arrays).
IMPLS="${IMPLS:-opinionated simple maxxed}"
port_of() { case "$1" in opinionated) echo 8091;; simple) echo 8092;; maxxed) echo 8093;; *) echo 0;; esac; }
seqs=()
for impl in $IMPLS; do seq_build "$impl" "$(port_of "$impl")" & seqs+=("$!"); done
wait "${seqs[@]}"

echo "=== HARDENING DONE ==="
