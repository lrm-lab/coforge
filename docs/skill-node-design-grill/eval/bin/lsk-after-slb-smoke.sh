#!/bin/bash
# After slb-lsk1-smoke summary, run protocol B gates. Full SLB starts only if they pass.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
LOG=$EVAL/logs/slb-smoke-lsk1.log
ATTEMPTS=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval/benchmark/evolbench-collab/result/lsk1-smoke/slb-lsk1-smoke-attempts.jsonl
PROGRESS=$EVAL/PROGRESS.md
mkdir -p "$EVAL/logs"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] after-slb-smoke watching $LOG" >> "$EVAL/logs/after-slb-smoke.log"
while true; do
  if grep -qE '\[lsk-slb-smoke\] DONE|wrote .*slb-lsk1-smoke-summary' "$LOG" 2>/dev/null; then
    break
  fi
  sleep 60
done
GATE_JSON=$EVAL/logs/slb-lsk1-smoke-gate.json
python3 "$EVAL/bin/lsk-slb-gate.py" "$ATTEMPTS" | tee "$GATE_JSON"
if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("pass") else 1)' "$GATE_JSON"; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | slb-smoke-gate | PASS $(python3 -c 'import json; print(json.load(open("'"$GATE_JSON"'")))')" >> "$PROGRESS"
  OTHER=$(pgrep -af 'benchmark/.*/src/run.ts' | grep -v 'cursor-lsk-eval' | grep -v 'bash -O' | grep -v 'bash -c' | grep -c . || true)
  if [ "${OTHER:-0}" -gt 2 ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | full-slb-warm | deferred after smoke PASS: $OTHER baseline runners" >> "$PROGRESS"
    exit 3
  fi
  setsid "$EVAL/bin/lsk-slb-full.sh" >> "$EVAL/logs/slb-full-launch.log" 2>&1 &
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | full-slb-warm | smoke PASS; started lsk-slb-full.sh" >> "$PROGRESS"
else
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | slb-smoke-gate | FAIL $(python3 -c 'import json; print(json.load(open("'"$GATE_JSON"'")))')" >> "$PROGRESS"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | full-slb-warm | not started; smoke gates failed" >> "$PROGRESS"
  exit 1
fi
