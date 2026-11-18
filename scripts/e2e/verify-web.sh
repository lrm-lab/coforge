#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
worktree=$(basename "$root")
hash=$(printf '%s' "$worktree" | cksum | cut -d' ' -f1)
slug=$(printf '%s' "$worktree" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '_' | cut -c1-32)_$hash
database="coforge_verify_$slug"
container="coforge-verify-${slug//_/-}-centrifugo"
state="$root/.amp/verify"
centrifugo_image="${CENTRIFUGO_IMAGE:-centrifugo/centrifugo:v6.9.2}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

claims="${TMPDIR:-/tmp}/coforge-verify-ports"
mkdir -p "$claims"
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
claim() {
  local lock="$claims/$1"
  if ! mkdir "$lock" 2>/dev/null; then
    kill -0 "$(cat "$lock/pid" 2>/dev/null || echo 0)" 2>/dev/null && return 1
    rm -rf "$lock"
    mkdir "$lock" 2>/dev/null || return 1
  fi
  echo $$ > "$lock/pid"
}
base=$((20000 + hash % 300 * 30))
front=""
for offset in $(seq 0 3 27); do
  candidate=$((base + offset))
  if port_free "$candidate" && port_free $((candidate + 1)) && port_free $((candidate + 2)) &&
    claim "$candidate"; then
    front=$candidate
    break
  fi
done
[ -n "$front" ] || fail "No free port block near $base for $worktree."
cleanup() {
  rm -f "$state/url"
  for pid in ${web_pid:-} ${front_pid:-}; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "${claims:?}/$front"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

web_port=$((front + 1))
centrifugo_port=$((front + 2))
web="http://127.0.0.1:$web_port"

secrets="$root/infra/secrets"
if ! test -s "$secrets/postgres_password"; then
  common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)
  secrets="$(dirname "$common")/infra/secrets"
fi
export COFORGE_E2E_SECRETS="$secrets"
export COFORGE_E2E_DATABASE="$database"
export COFORGE_CENTRIFUGO_API_URL="http://127.0.0.1:$centrifugo_port/api"

(cd "$root" && bun install --frozen-lockfile >/dev/null)
bun "$root/scripts/e2e/prepare-environment.ts"
# shellcheck source=scripts/e2e/e2e-env.sh
source "$root/scripts/e2e/e2e-env.sh"

bun "$root/apps/web/scripts/ensure-database.ts" "${DATABASE_URL%/*}/postgres" "$database"

docker rm -f "$container" >/dev/null 2>&1 || true
docker run -d --name "$container" --network host \
  -v "$root/infra/centrifugo:/centrifugo:ro" \
  -e CENTRIFUGO_HTTP_SERVER_ADDRESS=127.0.0.1 \
  -e CENTRIFUGO_HTTP_SERVER_PORT="$centrifugo_port" \
  -e CENTRIFUGO_HTTP_API_KEY="$COFORGE_CENTRIFUGO_API_KEY" \
  -e CENTRIFUGO_VAR_RPC_PROXY_SECRET="$COFORGE_CENTRIFUGO_PROXY_SECRET" \
  -e CENTRIFUGO_ENGINE_REDIS_ADDRESS="$REDIS_URL" \
  -e CENTRIFUGO_ENGINE_REDIS_PREFIX="verify-$slug" \
  -e 'CENTRIFUGO_CLIENT_ALLOWED_ORIGINS=["http://127.0.0.1:*","http://localhost:*"]' \
  -e CENTRIFUGO_CLIENT_TOKEN_JWKS_PUBLIC_ENDPOINT="$web/api/jwks" \
  -e CENTRIFUGO_CLIENT_PROXY_CONNECT_ENDPOINT="$web/api/internal/centrifugo-connect" \
  -e CENTRIFUGO_RPC_PROXY_ENDPOINT="$web/api/internal/centrifugo" \
  -e CENTRIFUGO_CHANNEL_PROXY_PUBLISH_ENDPOINT="$web/api/internal/centrifugo-agent-activity" \
  -e CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_ENDPOINT="$web/api/internal/centrifugo-subscribe" \
  -e CENTRIFUGO_CHANNEL_PROXY_SUB_REFRESH_ENDPOINT="$web/api/internal/centrifugo-sub-refresh" \
  "$centrifugo_image" centrifugo -c /centrifugo/config.yaml >/dev/null

bun run --cwd "$root/packages/coforge-sdk" generate
cd "$root/apps/web"
bun run db:migrate:deploy
NODE_ENV=production bun run build
bun run ./scripts/seed-dev-data.ts
export COFORGE_ARTIFACT_SANDBOX_ORIGIN="http://localhost:$front"
export COFORGE_FILE_STORAGE_DIR="$state/files"
COFORGE_WEB_PUSH_PUBLIC_KEY=$(<"$root/.amp/e2e/web-push-public-key") \
  COFORGE_WEB_PUSH_PRIVATE_KEY_FILE="$root/.amp/e2e/web-push-private-key" \
  COFORGE_WEB_PUSH_SUBJECT=https://coforge.cn \
  COFORGE_DEV_SKIP_AUTH=1 COFORGE_E2E_ALLOW_DEVICE_AUTH=0 NODE_ENV=development \
  HOST=127.0.0.1 PORT=$web_port \
  bun run ./scripts/start-server.ts &
web_pid=$!
healthy() {
  for _ in $(seq 1 90); do
    curl -fsS "$1/health" >/dev/null 2>&1 && return 0
    kill -0 "$2" 2>/dev/null || break
    sleep 1
  done
  fail "$1 did not become healthy."
}
healthy "$web" "$web_pid"

E2E_PROXY_PORT=$front E2E_PROXY_WEB_ORIGIN="$web" \
  E2E_PROXY_CENTRIFUGO_ORIGIN="ws://127.0.0.1:$centrifugo_port" \
  bun "$root/scripts/e2e/same-origin-proxy.ts" &
front_pid=$!
healthy "http://127.0.0.1:$front" "$front_pid"

mkdir -p "$state"
printf 'http://127.0.0.1:%s\n' "$front" > "$state/url"
printf 'VERIFY READY %s http://127.0.0.1:%s (Web %s, Centrifugo %s, database %s)\n' \
  "$worktree" "$front" "$web_port" "$centrifugo_port" "$database"
while kill -0 "$web_pid" 2>/dev/null && kill -0 "$front_pid" 2>/dev/null; do sleep 2; done
printf 'The Web or the front door stopped.\n' >&2
false
