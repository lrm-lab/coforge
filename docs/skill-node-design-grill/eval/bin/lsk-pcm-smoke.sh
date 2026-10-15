#!/bin/bash
# LoCoMo smoke on the isolated learned-skill stack.
# Sources local env files. Does not print them.
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
export COFORGE_PUBLIC_CHANNEL_MEMORY_EVAL=1
export COFORGE_WEB_URL="${COFORGE_WEB_URL:-http://127.0.0.1:18889}"
export COFORGE_EVAL_CENTRIFUGO_WS="${COFORGE_EVAL_CENTRIFUGO_WS:-ws://127.0.0.1:18001/connection/websocket}"
export COFORGE_EVAL_QA_LIMIT="${COFORGE_EVAL_QA_LIMIT:-1}"
export COFORGE_EVAL_INGEST_FROM_SESSION="${COFORGE_EVAL_INGEST_FROM_SESSION:-15}"
export COFORGE_EVAL_ARMS="${COFORGE_EVAL_ARMS:-openviking}"
export COFORGE_EVAL_SAMPLE_ID="${COFORGE_EVAL_SAMPLE_ID:-conv-26}"
export COFORGE_EVAL_POLL_TIMEOUT_MS="${COFORGE_EVAL_POLL_TIMEOUT_MS:-360000}"
export COFORGE_EVAL_RESULT_DIR="${COFORGE_EVAL_RESULT_DIR:-$ROOT/benchmark/public-channel-memory/result/lsk1-smoke}"
export COFORGE_EVAL_DISABLE_HOST_PI_INJECTION=1
cd "$ROOT"
exec bun benchmark/public-channel-memory/src/run.ts
