#!/bin/bash
# SkillLearnBench full run (95 warm + 76 cold) via evolbench-collab, with the
# official container sidecar (8732) for execution + verification.
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mims/shims:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
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
export COFORGE_EVAL_MANIFEST=/home/zhoujie22/river2_0/evol_bench/SkillLearnBench/data/slb-full.jsonl
export COFORGE_EVALUATION_ID=slb-full-collab-1
export COFORGE_EVAL_EPISODE_TIMEOUT_MS=1500000
export COFORGE_EVAL_VERIFY_SIDECAR=http://127.0.0.1:8732
export COFORGE_EVAL_ENV_NOTE='Environment: this task runs in an official Docker container managed by the env server at http://127.0.0.1:8732. First bind it: curl -s -X POST http://127.0.0.1:8732/env -H "content-type: application/json" -d "{\"task_id\": \"%TASK_ID%\", \"episode_id\": \"%EPISODE_ID%\"}" (the first bind may take a few minutes while the Docker image builds). Then every run_command from your preamble is executed as: curl -s -X POST http://127.0.0.1:8732/execute -H "content-type: application/json" -d "{\"episode_id\": \"%EPISODE_ID%\", \"command\": \"<your shell command>\", \"timeout_sec\": 600}". Execute the entire task through this endpoint; do not use your local shell for task work.'
LOG=/tmp/slb-full-collab-1.log
ATTEMPTS=benchmark/evolbench-collab/result/slb-full-collab-1-attempts.jsonl
while true; do
  setsid mise exec -- bun benchmark/evolbench-collab/src/run.ts >> "$LOG" 2>&1 &
  RUNNER=$!
  echo "[watchdog $RUNNER] started $(date -u +%H:%M:%S)" >> "$LOG"
  while kill -0 $RUNNER 2>/dev/null; do
    sleep 60
    if ! kill -0 $RUNNER 2>/dev/null; then break; fi
    NOW=$(date +%s); AGE=$((NOW - $(stat -c %Y "$ATTEMPTS" 2>/dev/null || echo $NOW)))
    if [ "$AGE" -gt 3000 ]; then
      echo "[watchdog] no progress for ${AGE}s, killing for resume" >> "$LOG"
      kill -9 -- -$RUNNER 2>/dev/null
      sleep 3
      cd /home/zhoujie22/river2_0/coforge/apps/web
      DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-) psql "$DATABASE_URL" -c "DELETE FROM workspaces WHERE slug LIKE 'evol-warm-slb\_%' OR slug LIKE 'evol-cold-slb\_%';" >/dev/null 2>&1
      cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
      break
    fi
    if grep -q "wrote .*slb-full-collab-1-summary" "$LOG" 2>/dev/null; then
      sleep 20; kill -9 -- -$RUNNER 2>/dev/null
      echo "[watchdog] DONE $(date -u +%H:%M:%S)" >> "$LOG"
      exit 0
    fi
  done
  wait $RUNNER 2>/dev/null
  if grep -q "wrote .*slb-full-collab-1-summary" "$LOG" 2>/dev/null; then
    kill -9 -- -$RUNNER 2>/dev/null
    echo "[watchdog] DONE (post-exit)" >> "$LOG"
    exit 0
  fi
  echo "[watchdog] restarting in 30s" >> "$LOG"
  sleep 30
done
