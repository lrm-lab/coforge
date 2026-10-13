#!/bin/bash
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
export COFORGE_EVAL_OV_ACCOUNT=pcm-333cee8082d6
export COFORGE_EVAL_INGEST_FROM_SESSION=20
export COFORGE_EVAL_ARMS=openviking
export COFORGE_EVAL_QA_LIMIT=152
export COFORGE_EVAL_SAMPLE_ID=conv-26
export COFORGE_EVAL_POLL_TIMEOUT_MS=300000
mise exec -- bun benchmark/public-channel-memory/src/run.ts
