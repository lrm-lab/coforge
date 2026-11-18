#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
test -n "${OPENROUTER_API_KEY:-}" || {
  printf 'OPENROUTER_API_KEY must be provided by the caller\n' >&2
  exit 1
}
"$root/scripts/e2e/start-e2e-infra.sh" >/dev/null
curl --fail --silent http://127.0.0.1:8789/health >/dev/null || {
  printf 'Start the E2E Web first: scripts/e2e/start-e2e-web.sh\n' >&2
  exit 1
}
# shellcheck source=scripts/e2e/e2e-env.sh
source "$root/scripts/e2e/e2e-env.sh"
unset COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY
exec mise exec -- bun test "$root/apps/web/test/e2e-openrouter-live.e2e.ts"
