#!/bin/bash
# Generic evolbench-collab shard on the isolated learned-skill stack.
# usage: lsk-evol-shard.sh <name> <manifest> <evalId> <arms> [families-comma|-] [mod|-] [extra env...]
set -euo pipefail
NAME=$1; MANIFEST=$2; EVALID=$3; ARMS=$4
FAMILIES=${5:-}
MOD=${6:-}
shift 6 || true
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
# shellcheck disable=SC1091
source "$EVAL/bin/lsk-common.sh"
export COFORGE_EVOLBENCH_COLLAB_EVAL=1
export COFORGE_EVAL_MANIFEST=$MANIFEST
export COFORGE_EVALUATION_ID=$EVALID
export COFORGE_EVAL_ARMS=$ARMS
export COFORGE_EVAL_RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$LSK_ROOT/benchmark/evolbench-collab/result}"
[ -n "${FAMILIES:-}" ] && [ "$FAMILIES" != "-" ] && export COFORGE_EVAL_FAMILIES=$FAMILIES
[ -n "${MOD:-}" ] && [ "$MOD" != "-" ] && export COFORGE_EVAL_EPISODE_MOD=$MOD
for kv in "$@"; do export "$kv"; done
LOG="${LOG:-$EVAL/logs/shard-$NAME.log}"
mkdir -p "$(dirname "$LOG")" "$COFORGE_EVAL_RESULT_DIR"
cd "$LSK_ROOT"
while true; do
  setsid bun benchmark/evolbench-collab/src/run.ts >> "$LOG" 2>&1 &
  RUNNER=$!
  LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  LASTGROW=$(date +%s)
  while kill -0 "$RUNNER" 2>/dev/null; do
    sleep 90
    kill -0 "$RUNNER" 2>/dev/null || break
    NEW=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    if grep -q "wrote .*$EVALID-summary" "$LOG" 2>/dev/null; then
      sleep 15
      kill -9 -- -"$RUNNER" 2>/dev/null || true
      echo "[shard-$NAME] DONE" >> "$LOG"
      exit 0
    fi
    if [ "$NEW" -gt "$LINES" ]; then
      LINES=$NEW
      LASTGROW=$(date +%s)
    fi
    if [ $(( $(date +%s) - LASTGROW )) -gt 900 ]; then
      echo "[shard-$NAME] silent for >15min, killing for resume" >> "$LOG"
      kill -9 -- -"$RUNNER" 2>/dev/null || true
      break
    fi
  done
  wait "$RUNNER" 2>/dev/null || true
  if grep -q "wrote .*$EVALID-summary" "$LOG" 2>/dev/null; then
    kill -9 -- -"$RUNNER" 2>/dev/null || true
    echo "[shard-$NAME] DONE (post)" >> "$LOG"
    exit 0
  fi
  sleep 20
done
