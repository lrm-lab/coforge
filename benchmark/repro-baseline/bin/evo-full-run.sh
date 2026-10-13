#!/bin/bash
# evolagentbench full run (268 warm + 86 cold) with crash-resume watchdog.
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$HOME/.pi/lenovo-ca-bundle.pem"
set -a
eval "$(grep -E '^(DATABASE_URL|REDIS_URL|COFORGE_CENTRIFUGO_API_URL|COFORGE_CENTRIFUGO_API_KEY|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' /home/zhoujie22/river2_0/coforge/apps/web/.env)"
set +a
export COFORGE_EVOLBENCH_COLLAB_EVAL=1
export COFORGE_WEB_URL=http://127.0.0.1:18888
export OPENVIKING_PROTOTYPE_ENABLED=1
export COFORGE_OPENVIKING_URL=http://127.0.0.1:1933
export COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE=/tmp/pcm-eval-ov-keys.json
export COFORGE_EVAL_RESUME=1
export COFORGE_EVAL_ARMS=warm,cold
export COFORGE_EVAL_MANIFEST=/home/zhoujie22/river2_0/evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl
export COFORGE_EVALUATION_ID=evo-code-full-collab-1
LOG=/tmp/evo-code-full-collab-1.log
ATTEMPTS=benchmark/evolbench-collab/result/evo-code-full-collab-1-attempts.jsonl
STALL_KILL=0
while true; do
  setsid mise exec -- bun benchmark/evolbench-collab/src/run.ts >> "$LOG" 2>&1 &
  RUNNER=$!
  echo "[watchdog $RUNNER] runner started $(date -u +%H:%M:%S)" >> "$LOG"
  # inactivity watchdog: no new attempts row for 45 min -> kill (resume skips done episodes)
  while kill -0 $RUNNER 2>/dev/null; do
    sleep 60
    if ! kill -0 $RUNNER 2>/dev/null; then break; fi
    NOW=$(date +%s); AGE=$((NOW - $(stat -c %Y "$ATTEMPTS" 2>/dev/null || echo $NOW)))
    if [ "$AGE" -gt 2700 ]; then
      echo "[watchdog] no attempts progress for ${AGE}s, killing for resume" >> "$LOG"
      kill -9 -- -$RUNNER 2>/dev/null
      STALL_KILL=1
      break
    fi
    if grep -q "wrote .*evo-code-full-collab-1-summary" "$LOG" 2>/dev/null; then
      echo "[watchdog] summary written, stopping" >> "$LOG"
      sleep 20; kill -9 -- -$RUNNER 2>/dev/null
      echo "[watchdog] DONE $(date -u +%H:%M:%S)" >> "$LOG"
      exit 0
    fi
  done
  wait $RUNNER 2>/dev/null
  CODE=$?
  echo "[watchdog] runner exited code=$CODE stall=$STALL_KILL" >> "$LOG"
  if grep -q "wrote .*evo-code-full-collab-1-summary" "$LOG" 2>/dev/null; then
    kill -9 -- -$RUNNER 2>/dev/null
    echo "[watchdog] DONE (post-exit) $(date -u +%H:%M:%S)" >> "$LOG"
    exit 0
  fi
  echo "[watchdog] restarting in 30s" >> "$LOG"
  sleep 30
done
