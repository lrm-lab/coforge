#!/bin/bash
# Sequential LoCoMo10 samples on the isolated learned-skill stack.
# Reaps the runner after it writes attempts (prisma $disconnect hang).
# Kills only the child PID — never pkill -f.
set -u
EVAL=/home/zhoujie22/river2_0/skill-node-design-grill/eval
# shellcheck disable=SC1091
source "$EVAL/bin/lsk-common.sh"
export COFORGE_PUBLIC_CHANNEL_MEMORY_EVAL=1
export COFORGE_EVAL_ARMS="${COFORGE_EVAL_ARMS:-openviking}"
export COFORGE_EVAL_QA_LIMIT="${COFORGE_EVAL_QA_LIMIT:-250}"
export COFORGE_EVAL_POLL_TIMEOUT_MS="${COFORGE_EVAL_POLL_TIMEOUT_MS:-300000}"
export COFORGE_EVAL_RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$LSK_ROOT/benchmark/public-channel-memory/result}"
mkdir -p "$COFORGE_EVAL_RESULT_DIR"
SAMPLES="${1:-conv-26 conv-30 conv-41 conv-42 conv-43 conv-44 conv-47 conv-48 conv-49 conv-50}"
cd "$LSK_ROOT"
for SAMPLE in $SAMPLES; do
  LOG=$EVAL/logs/pcm-$SAMPLE.log
  echo "[$(date -u +%H:%M:%S)] starting $SAMPLE"
  export COFORGE_EVAL_SAMPLE_ID=$SAMPLE
  unset COFORGE_EVAL_OV_ACCOUNT COFORGE_EVAL_INGEST_FROM_SESSION
  bun benchmark/public-channel-memory/src/run.ts > "$LOG" 2>&1 &
  EVAL_PID=$!
  WROTE=0
  for _ in $(seq 1 2880); do
    if grep -q "^wrote .*/attempts-" "$LOG" 2>/dev/null; then WROTE=1; break; fi
    if ! kill -0 "$EVAL_PID" 2>/dev/null; then break; fi
    sleep 5
  done
  sleep 3
  kill "$EVAL_PID" 2>/dev/null || true
  sleep 3
  kill -9 "$EVAL_PID" 2>/dev/null || true
  if [ "$WROTE" = "1" ]; then
    echo "[$(date -u +%H:%M:%S)] $SAMPLE done: $(grep -c mechanism "$LOG" || true) questions, $(grep '^wrote ' "$LOG" | tail -1)"
  else
    echo "[$(date -u +%H:%M:%S)] $SAMPLE FAILED without results; last lines:"
    tail -5 "$LOG" | sed 's/^/    /'
    echo "[$(date -u +%H:%M:%S)] aborting remaining samples"
    exit 1
  fi
done
echo "[$(date -u +%H:%M:%S)] all samples complete"
