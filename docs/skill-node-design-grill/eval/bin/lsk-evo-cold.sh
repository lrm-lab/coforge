#!/bin/bash
# Full cold arm of EvoAgentBench on the isolated learned-skill stack.
# Fresh workspace per episode. Resume-safe. 15-minute silence restart.
set -euo pipefail
ROOT=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
# shellcheck disable=SC1091
source "$EVAL/bin/lsk-common.sh"
LOG=${LOG:-$EVAL/logs/evo-cold-lsk1.log}
EVALID=${COFORGE_EVALUATION_ID:-evo-lsk1-cold}
export COFORGE_EVOLBENCH_COLLAB_EVAL=1
export COFORGE_EVAL_MANIFEST="${COFORGE_EVAL_MANIFEST:-/home/zhoujie22/river2_0/evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl}"
export COFORGE_EVAL_ARMS=cold
export COFORGE_EVALUATION_ID="$EVALID"
export COFORGE_EVAL_RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$ROOT/benchmark/evolbench-collab/result}"
mkdir -p "$(dirname "$LOG")" "$COFORGE_EVAL_RESULT_DIR"
cd "$ROOT"
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
      echo "[lsk-evo-cold] DONE" >> "$LOG"
      exit 0
    fi
    if [ "$NEW" -gt "$LINES" ]; then
      LINES=$NEW
      LASTGROW=$(date +%s)
    fi
    if [ $(( $(date +%s) - LASTGROW )) -gt 900 ]; then
      echo "[lsk-evo-cold] silent for >15min, killing for resume" >> "$LOG"
      kill -9 -- -"$RUNNER" 2>/dev/null || true
      break
    fi
  done
  wait "$RUNNER" 2>/dev/null || true
  if grep -q "wrote .*$EVALID-summary" "$LOG" 2>/dev/null; then
    kill -9 -- -"$RUNNER" 2>/dev/null || true
    echo "[lsk-evo-cold] DONE (post)" >> "$LOG"
    exit 0
  fi
  sleep 20
done
