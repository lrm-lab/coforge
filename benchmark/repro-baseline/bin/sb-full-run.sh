#!/bin/bash
# skillsbench-collab full run: one bun process per task (crash-resumable —
# tasks already present in any attempts file are skipped).
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$HOME/.pi/lenovo-ca-bundle.pem"
set -a
eval "$(grep -E '^(DATABASE_URL|REDIS_URL|COFORGE_CENTRIFUGO_API_URL|COFORGE_CENTRIFUGO_API_KEY|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' /home/zhoujie22/river2_0/coforge/apps/web/.env)"
. /tmp/pcm-cursor-api-key.env 2>/dev/null
set +a
export COFORGE_SKILLSBENCH_COLLAB_EVAL=1
export COFORGE_WEB_URL=http://127.0.0.1:18888
export OPENVIKING_PROTOTYPE_ENABLED=1
export COFORGE_OPENVIKING_URL=http://127.0.0.1:1933
export COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE=/tmp/pcm-eval-ov-keys.json
RESULT_DIR=benchmark/skillsbench-collab/result
LOG=/tmp/sb-full-run.log
echo "[sb-marathon] start $(date -u +%H:%M:%S)" >> "$LOG"
for TASK in $(ls benchmark/skillsbench-collab/bench_data/tasks | sort); do
  # skip tasks that already produced a verification row in any attempts file
  if grep -l "\"taskName\":\"$TASK\"" $RESULT_DIR/attempts-*.jsonl >/dev/null 2>&1; then
    echo "[sb-marathon] skip $TASK (already recorded)" >> "$LOG"
    continue
  fi
  echo "[sb-marathon] $(date -u +%H:%M:%S) starting $TASK" >> "$LOG"
  mise exec -- bun benchmark/skillsbench-collab/src/run.ts >> /tmp/sb-eval-$TASK.log 2>&1 &
  PID=$!
  # watchdog: kill when the attempts line for this task lands, or after
  # poll timeout (2700s) + verify (900s) + margin
  DEADLINE=$(( $(date +%s) + 4500 ))
  while kill -0 $PID 2>/dev/null; do
    sleep 20
    if grep -q "\"taskName\":\"$TASK\"" $RESULT_DIR/attempts-*.jsonl 2>/dev/null; then
      sleep 15; kill -9 $PID 2>/dev/null
      pkill -9 -f 'skillsbench-collab/src/run.ts' 2>/dev/null
      break
    fi
    if [ "$(date +%s)" -gt "$DEADLINE" ]; then
      echo "[sb-marathon] $TASK timed out, killing for next task" >> "$LOG"
      kill -9 $PID 2>/dev/null
      pkill -9 -f 'skillsbench-collab/src/run.ts' 2>/dev/null
      sleep 5
      # clean any leftover workspace so bindings don't accumulate
      cd /home/zhoujie22/river2_0/coforge/apps/web
      DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-) psql "$DATABASE_URL" -c "DELETE FROM workspaces WHERE slug LIKE 'sb-collab-%';" >/dev/null 2>&1
      cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
      break
    fi
  done
  wait $PID 2>/dev/null
  echo "[sb-marathon] $(date -u +%H:%M:%S) $TASK done" >> "$LOG"
done
echo "[sb-marathon] ALL DONE $(date -u +%H:%M:%S)" >> "$LOG"
