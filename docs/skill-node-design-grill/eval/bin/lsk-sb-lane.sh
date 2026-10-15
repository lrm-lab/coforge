#!/bin/bash
# SkillsBench lane L of N on the isolated learned-skill stack.
# FIX: runner task selection comes from COFORGE_EVAL_TASKS.
set -euo pipefail
LANE=${1:?lane}
LANES=${2:-4}
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
# shellcheck disable=SC1091
source "$EVAL/bin/lsk-common.sh"
export COFORGE_SKILLSBENCH_COLLAB_EVAL=1
export COFORGE_EVAL_ARMS="${COFORGE_EVAL_ARMS:-openviking,cold}"
RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$LSK_ROOT/benchmark/skillsbench-collab/result}"
LOG="${LOG:-$EVAL/logs/sb-lane$LANE.log}"
mkdir -p "$RESULT_DIR" "$(dirname "$LOG")"
cd "$LSK_ROOT"
TASKS=$(ls benchmark/skillsbench-collab/bench_data/tasks | sort | awk -v l="$LANE" -v n="$LANES" 'NR%n==((l+n)%n)')
echo "[lane$LANE] $(echo "$TASKS" | wc -w) tasks (mod $LANES)" >> "$LOG"
for TASK in $TASKS; do
  if grep -l "\"taskName\":\"$TASK\"" "$RESULT_DIR"/attempts-*.jsonl >/dev/null 2>&1; then
    echo "[lane$LANE] skip $TASK" >> "$LOG"
    continue
  fi
  echo "[lane$LANE] $(date -u +%H:%M:%S) starting $TASK" >> "$LOG"
  COFORGE_EVAL_TASKS="$TASK" COFORGE_EVAL_RESULT_DIR="$RESULT_DIR" \
    setsid bun benchmark/skillsbench-collab/src/run.ts >> "$EVAL/logs/sb-eval-$TASK.log" 2>&1 &
  PID=$!
  DEADLINE=$(( $(date +%s) + 4500 ))
  while kill -0 "$PID" 2>/dev/null; do
    sleep 20
    if grep -q "\"taskName\":\"$TASK\"" "$RESULT_DIR"/attempts-*.jsonl 2>/dev/null; then
      sleep 15
      kill -9 -- -"$PID" 2>/dev/null || true
      break
    fi
    if [ "$(date +%s)" -gt "$DEADLINE" ]; then
      echo "[lane$LANE] $TASK timed out" >> "$LOG"
      kill -9 -- -"$PID" 2>/dev/null || true
      sleep 5
      export DATABASE_URL
      psql "$DATABASE_URL" -c "DELETE FROM workspaces WHERE slug LIKE 'lsk-sb-%-$TASK-________';" >/dev/null 2>&1 || true
      break
    fi
  done
  wait "$PID" 2>/dev/null || true
  echo "[lane$LANE] $(date -u +%H:%M:%S) $TASK done" >> "$LOG"
done
echo "[lane$LANE] LANE DONE" >> "$LOG"
