#!/bin/bash
cd "$(dirname "${BASH_SOURCE[0]}")/../../../apps/web"
export PATH="$HOME/.local/share/mise/installs/bun/1.4.2/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
set -a
eval "$(grep -E '^(DATABASE_URL|REDIS_URL|COFORGE_CENTRIFUGO_API_URL|COFORGE_CENTRIFUGO_API_KEY|COFORGE_CENTRIFUGO_PROXY_SECRET|COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)=' /home/zhoujie22/river2_0/coforge/apps/web/.env)"
set +a
if [ -n "${COFORGE_EVAL_DATABASE_NAME:-}" ]; then
  export DATABASE_URL="${DATABASE_URL%/*}/${COFORGE_EVAL_DATABASE_NAME}"
fi
if [ -n "${COFORGE_EVAL_CENTRIFUGO_API_URL:-}" ]; then
  export COFORGE_CENTRIFUGO_API_URL="$COFORGE_EVAL_CENTRIFUGO_API_URL"
fi
export OPENVIKING_PROTOTYPE_ENABLED=1
export COFORGE_OPENVIKING_URL=${COFORGE_OPENVIKING_URL:-http://127.0.0.1:1933}
export COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE=/tmp/pcm-eval-ov-keys.json
if [ "${COFORGE_EVAL_WEB_PRODUCTION:-0}" = 1 ]; then
  export PORT="${COFORGE_EVAL_WEB_PORT:-18888}"
  export HOST=127.0.0.1
  exec bun .output/server/index.mjs
fi
exec bun node_modules/.bin/vite dev --port "${COFORGE_EVAL_WEB_PORT:-18888}" --host 127.0.0.1 --strictPort
