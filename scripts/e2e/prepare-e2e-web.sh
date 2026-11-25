#!/usr/bin/env bash
# Shared Web E2E build, physical Paraglide generation, and baseline seed sequence.
# Used by run-web-e2e-ci.sh, verify-web.sh, and start-e2e-web.sh so the runners cannot drift.
#
# Order matters:
# 1. Generate SDK protobuf modules and apply database migrations.
# 2. Build the Web with NODE_ENV=production (Vite emits virtual-modules under dist-ssr/paraglide
#    and does not create physical apps/web/src/paraglide modules).
# 3. Generate physical Paraglide message-modules AFTER the Vite build and BEFORE any direct Bun
#    seed/test script imports `#src/paraglide/messages`.
# 4. Seed baseline dev data (`seed-dev-data.ts`, plus `seed-dev.ts` when `--with-dev-seed` is set).
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
with_dev_seed=0
if [ "${1:-}" = "--with-dev-seed" ]; then
  with_dev_seed=1
elif [ $# -gt 0 ]; then
  printf 'Usage: %s [--with-dev-seed]\n' "$0" >&2
  exit 1
fi

bun run --cwd "$root/packages/coforge-sdk" generate
cd "$root/apps/web"
bun run db:migrate:deploy
NODE_ENV=production bun run build
bun run generate-i18n
bun run ./scripts/seed-dev-data.ts
if [ "$with_dev_seed" -eq 1 ]; then
  bun run ./scripts/seed-dev.ts
fi
