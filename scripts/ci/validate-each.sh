#!/usr/bin/env bash
# Validate every selected script suite or library package in one CI job. Each is small, and a
# job apiece would hold one of the account's concurrent job slots for about 25 seconds of setup.
# Runs all of them before failing, so one run reports every failure.
# Usage: validate-each.sh scripts|libraries '<JSON array from Plan checks>'
set -uo pipefail
kind="$1"
names="$(jq -r '.[]' <<<"$2")" || exit 1
failed=()
for name in $names; do
  echo "::group::$name"
  if [ "$kind" = scripts ]; then
    bun run "test:$name" && bun run "check:$name"
  else
    dir="packages/$name"
    # Built only when its manifest declares a build (coforge-sdk does not): `bun run --if-present`
    # is documented for a missing entrypoint file, not a missing script.
    bun run --cwd "$dir" test && bun run --cwd "$dir" check &&
      { ! jq -e '.scripts.build' "$dir/package.json" >/dev/null || bun run --cwd "$dir" build; }
  fi
  status=$?
  echo "::endgroup::"
  if [ "$status" -ne 0 ]; then
    failed+=("$name")
    echo "::error::$name failed"
  fi
done
if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::Failed: ${failed[*]}"
  exit 1
fi
