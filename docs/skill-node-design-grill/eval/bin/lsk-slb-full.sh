#!/bin/bash
# SkillLearnBench full warm-loop then (via lsk-after-slb-warm.sh) cold.
# Sequential one-process family accumulation — do not shard three ways onto the shared model.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
mkdir -p "$EVAL/logs"
if pgrep -f 'eval/bin/lsk-slb-warm.sh' >/dev/null; then
  echo "lsk-slb-warm.sh already running"
  exit 0
fi
setsid "$EVAL/bin/lsk-slb-warm.sh" >> "$EVAL/logs/slb-warm-lsk1.log" 2>&1 &
echo "started lsk-slb-warm.sh pid $!"
if ! pgrep -f 'eval/bin/lsk-after-slb-warm.sh' >/dev/null; then
  setsid "$EVAL/bin/lsk-after-slb-warm.sh" >> "$EVAL/logs/after-slb-warm.log" 2>&1 &
  echo "started lsk-after-slb-warm.sh pid $!"
fi
