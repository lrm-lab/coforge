#!/bin/bash
# Wait for evo-lsk1-cold to finish, then offline-grade. Never relaunches cold.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
COLD_LOG=$EVAL/logs/evo-cold-lsk1.log
ATTEMPTS=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval/benchmark/evolbench-collab/result/evo-lsk1-cold-attempts.jsonl
OUT=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval/benchmark/evolbench-collab/result/evo-lsk1-cold-graded
PROGRESS=$EVAL/PROGRESS.md
WATCH=$EVAL/logs/after-cold.log
mkdir -p "$(dirname "$WATCH")"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] after-cold watching $COLD_LOG" >> "$WATCH"
while true; do
  if grep -qE '\[lsk-evo-cold\] DONE|wrote .*evo-lsk1-cold-summary' "$COLD_LOG" 2>/dev/null; then
    break
  fi
  COLD_ALIVE=0
  if pgrep -f 'eval/bin/lsk-evo-cold.sh' >/dev/null; then
    COLD_ALIVE=1
  fi
  if pgrep -f 'cursor-lsk-eval/benchmark/evolbench-collab/src/run.ts' >/dev/null; then
    COLD_ALIVE=1
  fi
  if [ "$COLD_ALIVE" -eq 0 ]; then
    if ! grep -qE '\[lsk-evo-cold\] DONE|wrote .*evo-lsk1-cold-summary' "$COLD_LOG" 2>/dev/null; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cold wrapper missing; not auto-restarting" >> "$WATCH"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | after-cold | cold wrapper gone before summary; not restarted" >> "$PROGRESS"
      exit 2
    fi
    break
  fi
  sleep 60
done
if [ ! -s "$ATTEMPTS" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | grade-evo-cold | missing attempts file" >> "$PROGRESS"
  exit 3
fi
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | grade-evo-cold | starting offline grade" >> "$PROGRESS"
"$EVAL/bin/lsk-evo-grade.sh" "$ATTEMPTS" "$OUT" >> "$EVAL/logs/evo-lsk1-cold-grade.log" 2>&1
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | grade-evo-cold | wrote $OUT" >> "$PROGRESS"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] graded $OUT" >> "$WATCH"
