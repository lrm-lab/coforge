#!/bin/bash
# Keep isolated web on 18889. Does not touch 18888.
set -euo pipefail
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
LOG=$EVAL/logs/lsk-web.log
mkdir -p "$(dirname "$LOG")"
while true; do
  if curl -sf -o /dev/null http://127.0.0.1:18889/api/jwks; then
    sleep 30
    continue
  fi
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] web down, restarting" >> "$LOG"
  setsid "$EVAL/bin/lsk-web.sh" >> "$LOG" 2>&1 &
  sleep 15
done
