#!/bin/bash
# After slb-lsk1 warm summary, start slb-lsk1-cold if model load is light.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
WARM_LOG=$EVAL/logs/slb-warm-lsk1.log
COLD_LOG=$EVAL/logs/slb-cold-lsk1.log
PROGRESS=$EVAL/PROGRESS.md
mkdir -p "$EVAL/logs"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] after-slb-warm watching $WARM_LOG" >> "$EVAL/logs/after-slb-warm.log"
while true; do
  if grep -qE '\[lsk-slb-warm\] DONE|wrote .*slb-lsk1-summary' "$WARM_LOG" 2>/dev/null; then
    break
  fi
  sleep 60
done
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | full-slb-warm | warm finished or summary present; starting cold if load allows" >> "$PROGRESS"
OTHER=$(pgrep -af 'benchmark/.*/src/run.ts' | grep -v 'cursor-lsk-eval' | grep -v 'bash -O' | grep -v 'bash -c' | grep -c . || true)
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] other runners=$OTHER" >> "$EVAL/logs/after-slb-warm.log"
if [ "${OTHER:-0}" -gt 2 ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | full-slb-cold | deferred: $OTHER baseline runners still live" >> "$PROGRESS"
  exit 3
fi
if pgrep -f 'eval/bin/lsk-slb-cold.sh' >/dev/null; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] slb cold already running" >> "$EVAL/logs/after-slb-warm.log"
  exit 0
fi
setsid "$EVAL/bin/lsk-slb-cold.sh" >> "$COLD_LOG" 2>&1 &
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | full-slb-cold | started eval/bin/lsk-slb-cold.sh eval id slb-lsk1-cold" >> "$PROGRESS"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] started slb cold pid $!" >> "$EVAL/logs/after-slb-warm.log"
