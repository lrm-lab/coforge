#!/usr/bin/env bash
set -euo pipefail

if [ "${EVENT:-}" = "pull_request" ] || { [ -n "${BASE:-}" ] && git cat-file -e "${BASE}^{commit}" 2>/dev/null; }; then
  bun install --frozen-lockfile
  bun scripts/ci/run-checks.ts --lint-range "$BASE" "$HEAD"
fi
