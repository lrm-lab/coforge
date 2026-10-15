# Shared env for learned-skill eval scripts. Source, do not exec.
# Does not print secrets.
LSK_ROOT="${LSK_ROOT:-/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval}"
LSK_EVAL="${LSK_EVAL:-/home/zhoujie22/river2_0/skill-node-design-grill/eval}"
set -a
# shellcheck disable=SC1091
source "$LSK_ROOT/apps/web/.env"
# shellcheck disable=SC1091
source /tmp/pcm-cursor-api-key.env
set +a
export PATH="${HOME}/.local/share/mise/installs/bun/1.4.2/bin:${PATH}"
export NODE_EXTRA_CA_CERTS="${HOME}/.pi/lenovo-ca-bundle.pem"
export COFORGE_WEB_URL="${COFORGE_WEB_URL:-http://127.0.0.1:18889}"
export COFORGE_EVAL_CENTRIFUGO_WS="${COFORGE_EVAL_CENTRIFUGO_WS:-ws://127.0.0.1:18001/connection/websocket}"
export COFORGE_EVAL_DISABLE_HOST_PI_INJECTION=1
export COFORGE_EVAL_RESUME="${COFORGE_EVAL_RESUME:-1}"
