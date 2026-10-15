#!/bin/bash
# Watchdog for slb-lsk1-smoke. 15-minute silence restart. Resume after the first launch.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
LOG=${LOG:-$EVAL/logs/slb-smoke-lsk1.log}
EVALID=slb-lsk1-smoke
mkdir -p "$(dirname "$LOG")"
export COFORGE_EVAL_RESUME="${COFORGE_EVAL_RESUME:-0}"
FIRST=1
while true; do
  if [ "$FIRST" -eq 0 ]; then
    export COFORGE_EVAL_RESUME=1
  fi
  FIRST=0
  setsid "$EVAL/bin/lsk-slb-smoke.sh" >> "$LOG" 2>&1 &
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
      echo "[lsk-slb-smoke] DONE" >> "$LOG"
      exit 0
    fi
    if [ "$NEW" -gt "$LINES" ]; then
      LINES=$NEW
      LASTGROW=$(date +%s)
    fi
    if [ $(( $(date +%s) - LASTGROW )) -gt 3000 ]; then
      echo "[lsk-slb-smoke] silent for >50min, killing for resume" >> "$LOG"
      kill -9 -- -"$RUNNER" 2>/dev/null || true
      break
    fi
  done
  wait "$RUNNER" 2>/dev/null || true
  if grep -q "wrote .*$EVALID-summary" "$LOG" 2>/dev/null; then
    kill -9 -- -"$RUNNER" 2>/dev/null || true
    echo "[lsk-slb-smoke] DONE (post)" >> "$LOG"
    exit 0
  fi
  sleep 20
done
