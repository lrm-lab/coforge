#!/bin/bash
# Full warm arm of EvoAgentBench on the isolated learned-skill stack.
# One family (code_implementation): episodes run in order in one workspace.
# Resume-safe. Restarts the runner when it goes silent for 15 minutes.
set -euo pipefail
ROOT=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval
LOG=${LOG:-/home/zhoujie22/river2_0/skill-node-design-grill/eval/evo-warm-lsk1.log}
EVALID=${COFORGE_EVALUATION_ID:-evo-lsk1}
set -a
# shellcheck disable=SC1091
source "$ROOT/apps/web/.env"
# shellcheck disable=SC1091
source /tmp/pcm-cursor-api-key.env
set +a
export PATH="${HOME}/.local/share/mise/installs/bun/1.4.2/bin:${PATH}"
export NODE_EXTRA_CA_CERTS="${HOME}/.pi/lenovo-ca-bundle.pem"
export COFORGE_EVOLBENCH_COLLAB_EVAL=1
export COFORGE_WEB_URL="${COFORGE_WEB_URL:-http://127.0.0.1:18889}"
export COFORGE_EVAL_CENTRIFUGO_WS="${COFORGE_EVAL_CENTRIFUGO_WS:-ws://127.0.0.1:18001/connection/websocket}"
export COFORGE_EVAL_MANIFEST="${COFORGE_EVAL_MANIFEST:-/home/zhoujie22/river2_0/evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl}"
export COFORGE_EVAL_ARMS=warm
export COFORGE_EVALUATION_ID="$EVALID"
export COFORGE_EVAL_RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$ROOT/benchmark/evolbench-collab/result}"
export COFORGE_EVAL_RESUME=1
export COFORGE_EVAL_DISABLE_HOST_PI_INJECTION=1
cd "$ROOT"
while true; do
  setsid bun benchmark/evolbench-collab/src/run.ts >> "$LOG" 2>&1 &
  RUNNER=$!
  LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  LASTGROW=$(date +%s)
  while kill -0 "$RUNNER" 2>/dev/null; do
    sleep 90
    kill -0 "$RUNNER" 2>/dev/null || break
    NEW=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    if grep -q "wrote .*$EVALID-summary" "$LOG" 2>/dev/null; then
      sleep 15
      kill -9 -- -"$RUNNER" 2>/dev/null || true
      echo "[lsk-evo-warm] DONE" >> "$LOG"
      exit 0
    fi
    if [ "$NEW" -gt "$LINES" ]; then
      LINES=$NEW
      LASTGROW=$(date +%s)
    fi
    if [ $(( $(date +%s) - LASTGROW )) -gt 900 ]; then
      echo "[lsk-evo-warm] silent for >15min, killing for resume" >> "$LOG"
      kill -9 -- -"$RUNNER" 2>/dev/null || true
      break
    fi
  done
  wait "$RUNNER" 2>/dev/null || true
  if grep -q "wrote .*$EVALID-summary" "$LOG" 2>/dev/null; then
    kill -9 -- -"$RUNNER" 2>/dev/null || true
    echo "[lsk-evo-warm] DONE (post)" >> "$LOG"
    exit 0
  fi
  sleep 20
done
