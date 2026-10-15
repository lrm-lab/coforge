#!/bin/bash
# Append a progress line every 30 minutes while evo-lsk1-cold is running.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
ATTEMPTS=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval/benchmark/evolbench-collab/result/evo-lsk1-cold-attempts.jsonl
LOG=$EVAL/logs/evo-cold-lsk1.log
LAST=-1
while true; do
  N=$(wc -l < "$ATTEMPTS" 2>/dev/null || echo 0)
  N=${N// /}
  if [ "$N" != "$LAST" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | evo-cold-tick | attempts=$N/268 last=$(tail -1 "$ATTEMPTS" 2>/dev/null | python3 -c 'import sys,json; o=json.loads(sys.stdin.read() or "{}"); print(o.get("episode_id","?"), o.get("mechanism","?"))' 2>/dev/null || echo '?')" >> "$EVAL/PROGRESS.md"
    LAST=$N
  fi
  if grep -qE '\[lsk-evo-cold\] DONE|wrote .*evo-lsk1-cold-summary' "$LOG" 2>/dev/null; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | evo-cold-tick | summary present, snapshotter exiting" >> "$EVAL/PROGRESS.md"
    exit 0
  fi
  sleep 1800
done
