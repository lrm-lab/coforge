#!/bin/bash
# Wait for evo-lsk1 warm to finish, then start cold if model load is light.
# Never relaunches warm. Safe to run while lsk-evo-warm.sh is already looping.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
WARM_LOG=$EVAL/evo-warm-lsk1.log
COLD_LOG=$EVAL/logs/evo-cold-lsk1.log
PROGRESS=$EVAL/PROGRESS.md
mkdir -p "$EVAL/logs"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] after-warm watching $WARM_LOG" >> "$EVAL/logs/after-warm.log"
while true; do
  if grep -qE '\[lsk-evo-warm\] DONE|wrote .*evo-lsk1-summary' "$WARM_LOG" 2>/dev/null; then
    break
  fi
  WARM_ALIVE=0
  if ps -eo pid,cmd | awk '/eval\/bin\/lsk-evo-warm\.sh/ && $2 ~ /(bash|sh)$/ {found=1} END{exit !found}'; then
    WARM_ALIVE=1
  fi
  if ps -eo pid,cmd | awk '/cursor-lsk-eval\/benchmark\/evolbench-collab\/src\/run\.ts/ && $0 !~ /awk|cursor-agent/ {found=1} END{exit !found}'; then
    WARM_ALIVE=1
  fi
  if [ "$WARM_ALIVE" -eq 0 ]; then
    # Warm wrapper gone. Do not restart it here.
    if ! grep -q 'wrote .*evo-lsk1-summary' "$WARM_LOG" 2>/dev/null; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] warm wrapper missing; not auto-restarting (handoff)" >> "$EVAL/logs/after-warm.log"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | after-warm | warm wrapper gone before summary; not restarted" >> "$PROGRESS"
      exit 2
    fi
    break
  fi
  sleep 60
done
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | full-evo-warm | warm finished or summary present; starting cold if load allows" >> "$PROGRESS"
# Load check: count other evol/skillsbench runners besides our future cold.
OTHER=$(pgrep -af 'benchmark/.*/src/run.ts' | grep -v 'cursor-lsk-eval' | grep -v 'bash -O' | grep -v 'bash -c' | grep -c . || true)
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] other runners=$OTHER" >> "$EVAL/logs/after-warm.log"
if [ "${OTHER:-0}" -gt 2 ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | full-evo-cold | deferred: $OTHER baseline runners still live" >> "$PROGRESS"
  exit 3
fi
if pgrep -f 'eval/bin/lsk-evo-cold.sh' >/dev/null; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cold already running" >> "$EVAL/logs/after-warm.log"
  exit 0
fi
setsid "$EVAL/bin/lsk-evo-cold.sh" >> "$COLD_LOG" 2>&1 &
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | full-evo-cold | started eval/bin/lsk-evo-cold.sh eval id evo-lsk1-cold" >> "$PROGRESS"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] started cold pid $!" >> "$EVAL/logs/after-warm.log"
