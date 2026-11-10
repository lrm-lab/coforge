#!/usr/bin/env bash
# Runs one browser e2e from apps/web/test against a local Web service.
#
# The browser e2es are opt-in: `bun test` does not discover `.e2e.ts`, CI never runs them, and each
# file's doc comment carries its own prerequisites. This script is the entry point they were
# missing - `list` names the files, and a name runs one with the setup they have in common; `all`
# runs the CI-tracked set (`scripts/e2e/web-e2e-ci.txt`) one after another - the sweep to give a
# DOM-restructuring change before it merges (see docs/agents/testing.md).
#
# The file is always passed as a path (`./test/<file>`). A bare file name is a *filter* to
# `bun test`, so `bun test e2e-x.e2e.ts` runs zero tests and prints only a hint; the two spellings
# differ by exactly one `./`.
#
# It exports what a layout/rendering e2e needs: DATABASE_URL, REDIS_URL and COFORGE_E2E_WEB_URL.
# A file that also needs Centrifugo, the worker key material or a provider key has its own runner
# and mise task (test:e2e:agent-direct-message, test:e2e:mention-delivery, test:e2e:openrouter-live,
# test:e2e:mobile-no-horizontal-overflow); run it through that one instead.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
tests="$root/apps/web/test"

if [ -z "${1:-}" ] || [ "$1" = list ] || [ "$1" = --list ]; then
  cd "$tests"
  printf 'Browser e2e files (run one with: mise run test:e2e:web <file>):\n'
  for file in *.e2e.ts; do
    printf '  %s\n' "$file"
  done
  exit 0
fi

secrets="$root/infra/secrets"
need_secrets() {
  for file in redis_password postgres_password; do
    test -s "$secrets/$file" || {
      printf 'Run amp orb services ensure first.\n' >&2
      exit 1
    }
  done
}
need_secrets
# The same two values the other runners read from the managed stack's secrets; -x is deliberately
# not used, so a caller who already exported them keeps theirs.
export DATABASE_URL="${DATABASE_URL:-postgresql://coforge:$(<"$secrets/postgres_password")@127.0.0.1:5432/coforge}"
export REDIS_URL="${REDIS_URL:-redis://:$(<"$secrets/redis_password")@127.0.0.1:6379}"

if [ "$1" = all ]; then
  # The CI-tracked set is the curated one: files that need a database reset, a provider key, a
  # managed environment or extra wiring are off it on purpose (docs/release/web-e2e.md) and run
  # through their own runners. Files not yet listed passed no three clean runs; run those by name.
  list="$root/scripts/e2e/web-e2e-ci.txt"
  test -s "$list" || { printf 'No CI list at %s\n' "$list" >&2; exit 1; }
  cd "$root/apps/web"
  passed=0
  failed=0
  failed_files=""
  while IFS= read -r line; do
    name=${line%% *}
    [ -z "$name" ] && continue
    if bun test "./test/$name" >/dev/null 2>&1; then
      printf '  pass  %s\n' "$name"
      passed=$((passed + 1))
    else
      printf '  FAIL  %s (rerun: mise run test:e2e:web %s)\n' "$name" "$name"
      failed=$((failed + 1))
      failed_files="$failed_files $name"
    fi
  done < "$list"
  printf 'Browser e2e sweep: %d pass, %d fail%s\n' "$passed" "$failed" "$failed_files"
  [ "$failed" -eq 0 ]
  exit 0
fi

name=$1
case "$name" in
  *.e2e.ts) ;;
  *) name="$name.e2e.ts" ;;
esac
test -f "$tests/$name" || {
  printf 'No such browser e2e: %s (run the script with no argument to list them).\n' "$name" >&2
  exit 1
}
# The same two values the other runners read from the managed stack's secrets; -x is deliberately
# not used, so a caller who already exported them keeps theirs.
export DATABASE_URL="${DATABASE_URL:-postgresql://coforge:$(<"$secrets/postgres_password")@127.0.0.1:5432/coforge}"
export REDIS_URL="${REDIS_URL:-redis://:$(<"$secrets/redis_password")@127.0.0.1:6379}"
# 8788 is the dev server's port (`bun run dev` in apps/web, and what run-mobile-overflow.sh
# assumes). The standard managed stack publishes Web on 8789 instead: pass
# COFORGE_E2E_WEB_URL=http://127.0.0.1:8789 when the page under test is served by that one.
export COFORGE_E2E_WEB_URL="${COFORGE_E2E_WEB_URL:-http://127.0.0.1:8788}"

cd "$root/apps/web"
exec bun test "./test/$name"
