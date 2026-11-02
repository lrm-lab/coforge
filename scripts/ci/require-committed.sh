#!/usr/bin/env bash
# Fail when a generator's output under <path> differs from the commit, untracked files included:
# CI regenerated it, so the commit must already carry what it wrote.
# Usage: require-committed.sh <path>
set -euo pipefail
path="$1"
git diff --exit-code -- "$path"
untracked="$(git ls-files --others --exclude-standard -- "$path")"
if [ -n "$untracked" ]; then
  echo "::error::Commit the generated files under $path: $untracked"
  exit 1
fi
