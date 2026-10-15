#!/bin/bash
# Isolated learned-skill web on 127.0.0.1:18889. Sources apps/web/.env and the
# worker JWT file. Does not print either.
set -euo pipefail
ROOT=/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval
set -a
# shellcheck disable=SC1091
source "$ROOT/apps/web/.env"
set +a
jwk_file="$ROOT/apps/web/secrets/worker-jwt-private.jwk.json"
COFORGE_WORKER_JWT_PRIVATE_JWK=$(cat "$jwk_file")
export COFORGE_WORKER_JWT_PRIVATE_JWK
export PATH="${HOME}/.local/share/mise/installs/bun/1.4.2/bin:${PATH}"
export NODE_EXTRA_CA_CERTS="${HOME}/.pi/lenovo-ca-bundle.pem"
cd "$ROOT/apps/web"
exec bun node_modules/.bin/vite dev --port 18889 --host 127.0.0.1 --strictPort
