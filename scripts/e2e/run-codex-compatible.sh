#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
if [[ "$(uname -s)" != Linux || "${COFORGE_CODEX_E2E_DISPOSABLE:-}" != 1 ]]; then
  echo 'Run this acceptance in a disposable Linux Computer with egress blocked.' >&2
  exit 2
fi
if [[ "$HOME" != "$(getent passwd "$(id -u)" | cut -d: -f6)" ]]; then
  echo 'Use the real home of a disposable Linux user with its own systemd manager.' >&2
  exit 2
fi

: "${COFORGE_CODEX_E2E_CURRENT_MANIFEST:?Manifest of the installed current Computer}"
: "${COFORGE_CODEX_E2E_LEGACY_MANIFEST:?Manifest of the installed legacy Computer}"
: "${COFORGE_CODEX_E2E_REAL_CODEX:?Path to the isolated real Codex executable}"

manifest_commit() {
  bun -e 'const { commit } = await Bun.file(Bun.argv[1]).json(); if (!/^[a-f0-9]{40}$/.test(commit)) process.exit(2); console.log(commit)' "$1"
}

manifest_version=$(bun -e 'console.log((await Bun.file(Bun.argv[1]).json()).version)' "$COFORGE_CODEX_E2E_CURRENT_MANIFEST")
if [[ "$manifest_version" != "$("$HOME/.coforge/computer/install/active/coforge-computer" --cli-version)" ]]; then
  echo 'The current fixture manifest does not match the installed Computer.' >&2
  exit 2
fi

COFORGE_CODEX_E2E_CANDIDATE_SHA=$(manifest_commit "$COFORGE_CODEX_E2E_CURRENT_MANIFEST")
COFORGE_CODEX_E2E_LEGACY_SHA=$(manifest_commit "$COFORGE_CODEX_E2E_LEGACY_MANIFEST")
COFORGE_CODEX_E2E_CODEX_VERSION=$("$COFORGE_CODEX_E2E_REAL_CODEX" --version)
export COFORGE_CODEX_E2E_CANDIDATE_SHA COFORGE_CODEX_E2E_LEGACY_SHA COFORGE_CODEX_E2E_CODEX_VERSION

if [[ "$COFORGE_CODEX_E2E_CANDIDATE_SHA" != "$(git -C "$root" rev-parse HEAD)" ]]; then
  echo 'The current Computer and built Web checkout must use the same source commit.' >&2
  exit 2
fi

case "${1:-backend}" in
  backend) test_file=./test/e2e-codex-compatible-native.e2e.ts ;;
  browser) test_file=./test/e2e-codex-compatible-browser.e2e.ts ;;
  *) echo 'Choose the backend or browser acceptance phase.' >&2; exit 2 ;;
esac

cd "$root/apps/web"
exec bun "$root/scripts/test/isolated-test-run.ts" bun test "$test_file"
