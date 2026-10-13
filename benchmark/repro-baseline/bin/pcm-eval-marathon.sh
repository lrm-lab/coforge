#!/bin/bash
# Sequential fresh-account eval over the remaining LoCoMo10 samples.
# Each run: fresh OV account, full VLM ingest, all cat1-4 questions.
# The eval process hangs on prisma $disconnect after writing results
# (known), so this wrapper watches for the "wrote " lines and reaps it.
set -u
cd /home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$HOME/.pi/lenovo-ca-bundle.pem"
set -a
eval "$(
  grep -E '^(DATABASE_URL|REDIS_URL|COFORGE_CENTRIFUGO_API_URL|COFORGE_CENTRIFUGO_API_KEY|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' \
    /home/zhoujie22/river2_0/coforge/apps/web/.env
)"
. /tmp/pcm-cursor-api-key.env
set +a
export COFORGE_PUBLIC_CHANNEL_MEMORY_EVAL=1
export COFORGE_WEB_URL=http://127.0.0.1:18888
export OPENVIKING_PROTOTYPE_ENABLED=1
export COFORGE_OPENVIKING_URL=http://127.0.0.1:1933
export COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE=/tmp/pcm-eval-ov-keys.json
export COFORGE_EVAL_ARMS=openviking
export COFORGE_EVAL_QA_LIMIT=250
export COFORGE_EVAL_POLL_TIMEOUT_MS=300000

SAMPLES="${1:-conv-30 conv-41 conv-42 conv-43 conv-44 conv-47 conv-48 conv-49 conv-50}"

for SAMPLE in $SAMPLES; do
  LOG=/tmp/pcm-eval-$SAMPLE.log
  echo "[$(date -u +%H:%M:%S)] starting $SAMPLE"
  export COFORGE_EVAL_SAMPLE_ID=$SAMPLE
  unset COFORGE_EVAL_OV_ACCOUNT COFORGE_EVAL_INGEST_FROM_SESSION
  mise exec -- bun benchmark/public-channel-memory/src/run.ts > "$LOG" 2>&1 &
  EVAL_PID=$!
  WROTE=0
  # Max 4h per sample; poll every 5s for the results-written marker or natural exit.
  for i in $(seq 1 2880); do
    if grep -q "^wrote .*/attempts-" "$LOG" 2>/dev/null; then WROTE=1; break; fi
    if ! kill -0 $EVAL_PID 2>/dev/null; then break; fi
    sleep 5
  done
  sleep 3
  pkill -TERM -f "benchmark/public-channel-memory/src/run.ts" 2>/dev/null
  sleep 3
  pkill -KILL -f "benchmark/public-channel-memory/src/run.ts" 2>/dev/null
  if [ "$WROTE" = "1" ]; then
    echo "[$(date -u +%H:%M:%S)] $SAMPLE done: $(grep -c 'mechanism' "$LOG") questions, $(grep '^wrote ' "$LOG" | tail -1)"
  else
    echo "[$(date -u +%H:%M:%S)] $SAMPLE FAILED without results; last lines:"
    tail -5 "$LOG" | sed 's/^/    /'
    echo "[$(date -u +%H:%M:%S)] aborting remaining samples"
    exit 1
  fi
done
echo "[$(date -u +%H:%M:%S)] all samples complete"
