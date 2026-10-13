#!/bin/bash
# SkillFlow run via evolbench-collab with the skillflow sidecar (8733).
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
export COFORGE_EVAL_MANIFEST=/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/benchmark/evolbench-collab/data/skillflow.jsonl
export COFORGE_EVALUATION_ID=sf-full-collab-1
export COFORGE_EVAL_EPISODE_TIMEOUT_MS=2100000
export COFORGE_EVAL_VERIFY_SIDECAR=http://127.0.0.1:8733
export COFORGE_EVAL_ENV_NOTE='Environment: this task runs in an official Docker container managed by the env server at http://127.0.0.1:8733. First bind it: curl -s -X POST http://127.0.0.1:8733/env -H "content-type: application/json" -d "{\"task_id\": \"%TASK_ID%\", \"episode_id\": \"%EPISODE_ID%\"}" (the first bind may take a few minutes while the Docker image builds). Then run every command of the task as: curl -s -X POST http://127.0.0.1:8733/execute -H "content-type: application/json" -d "{\"episode_id\": \"%EPISODE_ID%\", \"command\": \"<your shell command>\", \"timeout_sec\": 600}" and read the files you produce through the same endpoint (e.g. cat). Execute the entire task through this endpoint; do not use your local shell for task work. Work in /root inside the container.'
LOG=/tmp/sf-full-collab-1.log
ATTEMPTS=benchmark/evolbench-collab/result/sf-full-collab-1-attempts.jsonl
while true; do
  setsid mise exec -- bun benchmark/evolbench-collab/src/run.ts >> "$LOG" 2>&1 &
  RUNNER=$!
  echo "[watchdog $RUNNER] started $(date -u +%H:%M:%S)" >> "$LOG"
  while kill -0 $RUNNER 2>/dev/null; do
    sleep 60
    if ! kill -0 $RUNNER 2>/dev/null; then break; fi
    NOW=$(date +%s); AGE=$((NOW - $(stat -c %Y "$ATTEMPTS" 2>/dev/null || echo $NOW)))
    if [ "$AGE" -gt 3600 ]; then
      echo "[watchdog] no progress for ${AGE}s, killing for resume" >> "$LOG"
      kill -9 -- -$RUNNER 2>/dev/null
      sleep 3
      cd /home/zhoujie22/river2_0/coforge/apps/web
      DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-) psql "$DATABASE_URL" -c "DELETE FROM workspaces WHERE slug LIKE 'evol-warm-sf\\_%' OR slug LIKE 'evol-cold-sf\\_%';" >/dev/null 2>&1
      cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
      break
    fi
    if grep -q "wrote .*sf-full-collab-1-summary" "$LOG" 2>/dev/null; then
      sleep 20; kill -9 -- -$RUNNER 2>/dev/null
      echo "[watchdog] DONE $(date -u +%H:%M:%S)" >> "$LOG"
      exit 0
    fi
  done
  wait $RUNNER 2>/dev/null
  if grep -q "wrote .*sf-full-collab-1-summary" "$LOG" 2>/dev/null; then
    kill -9 -- -$RUNNER 2>/dev/null
    echo "[watchdog] DONE (post-exit)" >> "$LOG"
    exit 0
  fi
  echo "[watchdog] restarting in 30s" >> "$LOG"
  sleep 30
done
