#!/usr/bin/env bash
# Runs one shard of the browser e2es CI must pass (scripts/e2e/web-e2e-ci.txt) against a stack it
# builds itself: the Web, built and served on 127.0.0.1:8788, a Centrifugo container that proxies to
# it, and the PostgreSQL and Redis the caller provides (the workflow's service containers).
#
#   scripts/e2e/run-web-e2e-ci.sh <shard> <shards>          e.g. 1 2
#   scripts/e2e/run-web-e2e-ci.sh <shard> <shards> --list   only print that shard's files
#
# Shards are balanced by the seconds the list records (longest first, each to the lighter shard),
# so both finish together. Every file runs once, in its own `bun test` process, with no retry: a
# file that fails is a red run. Each file's output, the Web's and Centrifugo's logs and the
# screenshots the tests write under .amp/e2e/ end up in $E2E_OUTPUT (default .amp/e2e-ci/), which
# the workflow uploads when the run fails.
#
# Two things the opt-in runners do not do and these files need: the full dev seed
# (apps/web/scripts/seed-dev.ts; many files look up its colleague, attached Computer and Agents
# with findFirstOrThrow), and one COFORGE_FILE_STORAGE_DIR shared by the Web and the tests (the
# attachment files write bytes there and read them back through the Web).
set -euo pipefail

shard=${1:?shard number (1-based)}
shards=${2:?number of shards}
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
list="$root/scripts/e2e/web-e2e-ci.txt"
output="${E2E_OUTPUT:-$root/.amp/e2e-ci}"
web_port=8788

# The shard's files: longest first, each to whichever shard has the fewest seconds so far.
# (A read loop, not mapfile: macOS still ships bash 3.2, and the list test runs there too.)
files=()
while IFS= read -r file; do files+=("$file"); done < <(
  grep -vE '^[[:space:]]*(#|$)' "$list" | LC_ALL=C sort -k2,2nr -k1,1 |
    awk -v want="$shard" -v n="$shards" '{
      best = 1
      for (i = 2; i <= n; i++) if (load[i] < load[best]) best = i
      load[best] += $2
      if (best == want) print $1
    }')
[ ${#files[@]} -gt 0 ] || { echo "shard $shard of $shards has no files" >&2; exit 1; }
# `--list` prints the shard's files and starts nothing (scripts/ci/web-e2e-list.test.ts).
if [ "${3:-}" = --list ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi
centrifugo_image="${CENTRIFUGO_IMAGE:?CENTRIFUGO_IMAGE names the Centrifugo image, by digest}"
mkdir -p "$output/files" "$output/logs"

export DATABASE_URL="${DATABASE_URL:-postgresql://coforge:test@127.0.0.1:5432/coforge}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export COFORGE_CENTRIFUGO_API_URL=http://127.0.0.1:8000/api
export COFORGE_CENTRIFUGO_API_KEY=e2e-api-key
export COFORGE_CENTRIFUGO_PROXY_SECRET=e2e-proxy-secret
export COFORGE_E2E_WEB_URL="http://127.0.0.1:$web_port"
export COFORGE_E2E_CENTRIFUGO_URL=http://127.0.0.1:8000
export COFORGE_FILE_STORAGE_DIR="$output/files"
# Files that launch Chrome themselves (helpers/headless-chrome.ts) default to the macOS install;
# on Linux, use the Chrome `agent-browser install` downloaded.
if [ -z "${COFORGE_E2E_CHROME:-}" ] && [ "$(uname -s)" = Linux ]; then
  COFORGE_E2E_CHROME=$(find "$HOME/.agent-browser/browsers" -type f -name chrome -perm -u+x 2>/dev/null | head -1)
  export COFORGE_E2E_CHROME
fi

cd "$root"
bun scripts/e2e/prepare-environment.ts
export COFORGE_WORKER_JWT_KEY_ID=coforge-e2e
export COFORGE_WORKER_JWT_PRIVATE_JWK
COFORGE_WORKER_JWT_PRIVATE_JWK=$(<"$root/.amp/e2e/worker-private.jwk")
export COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY_FILE="$root/.amp/e2e/agent-runtime-credential-key"

# Host networking: the container's 127.0.0.1 is the runner's, so the proxies reach the Web there.
# The checked-in config points them at the managed stack's :8789; the environment overrides that.
web="http://127.0.0.1:$web_port"
docker rm -f coforge-e2e-centrifugo >/dev/null 2>&1 || true
docker run -d --name coforge-e2e-centrifugo --network host \
  -v "$root/infra/centrifugo:/centrifugo:ro" \
  -e CENTRIFUGO_HTTP_API_KEY="$COFORGE_CENTRIFUGO_API_KEY" \
  -e CENTRIFUGO_VAR_RPC_PROXY_SECRET="$COFORGE_CENTRIFUGO_PROXY_SECRET" \
  -e CENTRIFUGO_ENGINE_REDIS_ADDRESS="$REDIS_URL" \
  -e 'CENTRIFUGO_CLIENT_ALLOWED_ORIGINS=["http://127.0.0.1:*","http://localhost:*"]' \
  -e CENTRIFUGO_CLIENT_TOKEN_JWKS_PUBLIC_ENDPOINT="$web/api/jwks" \
  -e CENTRIFUGO_CLIENT_PROXY_CONNECT_ENDPOINT="$web/api/internal/centrifugo-connect" \
  -e CENTRIFUGO_RPC_PROXY_ENDPOINT="$web/api/internal/centrifugo" \
  -e CENTRIFUGO_CHANNEL_PROXY_PUBLISH_ENDPOINT="$web/api/internal/centrifugo-agent-activity" \
  -e CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_ENDPOINT="$web/api/internal/centrifugo-subscribe" \
  -e CENTRIFUGO_CHANNEL_PROXY_SUB_REFRESH_ENDPOINT="$web/api/internal/centrifugo-sub-refresh" \
  "$centrifugo_image" centrifugo -c /centrifugo/config.yaml >/dev/null
# The screenshots are the subdirectories of .amp/e2e/; the files beside them are this run's keys,
# which stay out of the uploaded output.
trap 'docker logs coforge-e2e-centrifugo > "$output/logs/centrifugo.log" 2>&1 || true
  mkdir -p "$output/screenshots"
  find "$root/.amp/e2e" -mindepth 1 -maxdepth 1 -type d -exec cp -R {} "$output/screenshots/" \; 2>/dev/null || true
  [ -n "${web_pid:-}" ] && kill "$web_pid" 2>/dev/null || true
  docker rm -f coforge-e2e-centrifugo >/dev/null 2>&1 || true' EXIT

# Built with NODE_ENV=production, served with NODE_ENV=development and skip-auth: the order
# managed-web.sh uses (docs/agents/testing.md says why the other order fails every file).
bun run --cwd packages/coforge-sdk generate
cd "$root/apps/web"
bun run db:migrate:deploy
NODE_ENV=production bun run build
bun run ./scripts/seed-dev-data.ts
bun run ./scripts/seed-dev.ts
COFORGE_DEV_SKIP_AUTH=1 COFORGE_E2E_ALLOW_DEVICE_AUTH=0 NODE_ENV=development \
  HOST=127.0.0.1 PORT=$web_port \
  bun run ./scripts/start-server.ts > "$output/logs/web.log" 2>&1 &
web_pid=$!
for _ in $(seq 1 90); do
  curl -fsS "$web/health" >/dev/null 2>&1 && break
  kill -0 "$web_pid" 2>/dev/null || { echo "the Web exited; see web.log" >&2; exit 1; }
  sleep 1
done
curl -fsS "$web/health" >/dev/null

failed=()
summary="$output/summary.md"
printf '### Browser e2e shard %s of %s\n\n| File | Result | Seconds |\n| --- | --- | --- |\n' \
  "$shard" "$shards" > "$summary"
for file in "${files[@]}"; do
  start=$(date +%s)
  result=pass
  # A path, never a bare name: a bare name is a filter and runs nothing (docs/agents/testing.md).
  timeout 360 bun test "./test/$file" > "$output/logs/$file.log" 2>&1 || result=fail
  # A file that ran nothing is not a pass.
  grep -qE '^ *[1-9][0-9]* pass' "$output/logs/$file.log" || result=fail
  seconds=$(( $(date +%s) - start ))
  printf '%s %s (%ss)\n' "$result" "$file" "$seconds"
  printf '| %s | %s | %s |\n' "$file" "$result" "$seconds" >> "$summary"
  [ "$result" = pass ] || failed+=("$file")
  # A file that stopped the Web would fail every later one for a reason of its own: stop here.
  if ! curl -fsS "$web/health" >/dev/null 2>&1; then
    echo "the Web stopped answering after $file; see web.log" >&2
    printf '\nThe Web stopped answering after %s; later files did not run.\n' "$file" >> "$summary"
    failed+=("(Web down after $file)")
    break
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  printf '\n%s failed:\n' "${#failed[@]}" >&2
  printf '  %s\n' "${failed[@]}" >&2
  exit 1
fi
