#!/bin/bash
# longmemeval-collab smoke/eval launcher. Usage: /tmp/lme-eval-run.sh [SAMPLE_INDEX]
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
export COFORGE_LME_COLLAB_EVAL=1
export COFORGE_WEB_URL=http://127.0.0.1:18888
export OPENVIKING_PROTOTYPE_ENABLED=1
export COFORGE_OPENVIKING_URL=http://127.0.0.1:1933
export COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE=/tmp/pcm-eval-ov-keys.json
export COFORGE_EVAL_ARMS=openviking
export COFORGE_EVAL_SAMPLE_INDEX="${1:-0}"
export COFORGE_EVAL_DATA_PIN=08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894
export COFORGE_EVAL_POLL_TIMEOUT_MS=300000
# fresh OV account per sample; unset so run.ts provisions a disposable one
unset COFORGE_EVAL_OV_ACCOUNT || true
unset COFORGE_EVAL_INGEST_FROM_SESSION || true
mise exec -- bun benchmark/longmemeval-collab/src/run.ts
