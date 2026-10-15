#!/bin/bash
# One warm EvoAgentBench episode on the isolated learned-skill stack.
# Mechanism smoke: recall, memory_offer, task-agent reply. Offline grading is separate.
set -euo pipefail
ROOT=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval
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
export COFORGE_EVAL_MANIFEST="${COFORGE_EVAL_MANIFEST:-$ROOT/benchmark/evolbench-collab/data/lsk-evo-smoke.jsonl}"
export COFORGE_EVAL_ARMS="${COFORGE_EVAL_ARMS:-warm}"
export COFORGE_EVALUATION_ID="${COFORGE_EVALUATION_ID:-evo-lsk1-smoke}"
export COFORGE_EVAL_EPISODE_TIMEOUT_MS="${COFORGE_EVAL_EPISODE_TIMEOUT_MS:-900000}"
export COFORGE_EVAL_ABORT_QUIET_MS="${COFORGE_EVAL_ABORT_QUIET_MS:-600000}"
export COFORGE_EVAL_SETTLE_MS="${COFORGE_EVAL_SETTLE_MS:-60000}"
export COFORGE_EVAL_RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$ROOT/benchmark/evolbench-collab/result/lsk1-smoke}"
export COFORGE_EVAL_DISABLE_HOST_PI_INJECTION=1
export COFORGE_EVAL_RESUME="${COFORGE_EVAL_RESUME:-0}"
cd "$ROOT"
exec bun benchmark/evolbench-collab/src/run.ts
