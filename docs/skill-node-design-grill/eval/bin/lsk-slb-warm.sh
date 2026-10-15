#!/bin/bash
# SkillLearnBench full warm-loop (slb-lsk1): 95 episodes, family order, resume + 15min silence restart.
# Comparison protocol B: COFORGE_EVAL_LOOP_OFFER=1. Does not rerun evo-lsk1.
set -euo pipefail
ROOT=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
LOG=${LOG:-$EVAL/logs/slb-warm-lsk1.log}
EVALID=${COFORGE_EVALUATION_ID:-slb-lsk1}
# shellcheck disable=SC1091
source "$EVAL/bin/lsk-common.sh"
if ! ss -lnt | grep -q ':8734 '; then
  setsid "$EVAL/bin/lsk-sidecar.sh" slb >> "$EVAL/logs/sidecar-slb-8734.log" 2>&1 &
  for _ in $(seq 1 30); do
    ss -lnt | grep -q ':8734 ' && break
    sleep 1
  done
fi
export COFORGE_EVOLBENCH_COLLAB_EVAL=1
export COFORGE_EVAL_MANIFEST="${COFORGE_EVAL_MANIFEST:-/home/zhoujie22/river2_0/evol_bench/SkillLearnBench/data/slb-full.jsonl}"
export COFORGE_EVAL_ARMS=warm
export COFORGE_EVALUATION_ID="$EVALID"
export COFORGE_EVAL_RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$ROOT/benchmark/evolbench-collab/result}"
export COFORGE_EVAL_RESUME=1
export COFORGE_EVAL_DISABLE_HOST_PI_INJECTION=1
export COFORGE_EVAL_EPISODE_TIMEOUT_MS=1500000
export COFORGE_EVAL_ABORT_QUIET_MS=0
export COFORGE_EVAL_LOOP_OFFER=1
export COFORGE_EVAL_VERIFY_SIDECAR=http://127.0.0.1:8734
export COFORGE_EVAL_ENV_NOTE='Environment: the harness already bound this episode at http://127.0.0.1:8734 (POST /env for %TASK_ID% / %EPISODE_ID% is done). Execute every command as: curl -s -X POST http://127.0.0.1:8734/execute -H "content-type: application/json" -d "{\"episode_id\": \"%EPISODE_ID%\", \"command\": \"<your shell command>\", \"timeout_sec\": 600}". Do not use your local shell for task work. When finished, post a short completion listing each /root/ path you wrote.'
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
      echo "[lsk-slb-warm] DONE" >> "$LOG"
      exit 0
    fi
    if [ "$NEW" -gt "$LINES" ]; then
      LINES=$NEW
      LASTGROW=$(date +%s)
    fi
    if [ $(( $(date +%s) - LASTGROW )) -gt 3000 ]; then
      echo "[lsk-slb-warm] silent for >50min, killing for resume" >> "$LOG"
      kill -9 -- -"$RUNNER" 2>/dev/null || true
      break
    fi
  done
  wait "$RUNNER" 2>/dev/null || true
  if grep -q "wrote .*$EVALID-summary" "$LOG" 2>/dev/null; then
    kill -9 -- -"$RUNNER" 2>/dev/null || true
    echo "[lsk-slb-warm] DONE (post)" >> "$LOG"
    exit 0
  fi
  sleep 20
done
