#!/usr/bin/env bash
# Prepares a checkout and its scratch database for `mise run test:integration:web`: everything the
# runner needs and does not make itself. A developer runs it once per checkout and database; the
# scheduled workflow (.github/workflows/web-integration.yml) runs it before the runner.
#
# The runner stays what it was: it runs the suites and prepares nothing, so a task that only reads
# state never changes it behind the caller's back. Dependencies are installed beforehand
# (`bun install --frozen-lockfile`), and a fresh worktree needs `mise trust` first.
#
#   INTEGRATION_DATABASE_URL=postgresql://coforge:test@127.0.0.1:15440/coforge \
#     ./scripts/test/prepare-web-integration.sh
#
# The default matches the runner's. Without the generated inputs nearly every suite stops in under
# a second on a missing module (`#src/generated/prisma/client`, the SDK's RPC bindings,
# `#src/paraglide/runtime`); without the migrations, on a missing table; without the build,
# `server-lifecycle.integration.ts` finds no `.output/server`.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
database="${INTEGRATION_DATABASE_URL:-postgresql://coforge:test@127.0.0.1:15440/coforge}"

cd "$root"
bun run --cwd packages/coforge-sdk generate
bun run --cwd apps/web db:generate
DATABASE_URL="$database" bun run --cwd apps/web db:migrate:deploy
bun run --cwd apps/web generate-i18n
bun run --cwd apps/web build
