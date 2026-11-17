#!/usr/bin/env bash
# Resolve the base commit for CI's Plan checks step:
# - workflow_dispatch on a non-main branch: merge-base with origin/main
# - push (or workflow_dispatch on main): head of the last successful push run
#   so cancelled and failed pushes stay in scope until a run passes.
set -euo pipefail

if [ "${EVENT:-}" = "workflow_dispatch" ] && [ "${BRANCH:-}" != "main" ]; then
  sha="$(git merge-base origin/main HEAD 2>/dev/null || true)"
  echo "sha=$sha" >> "$GITHUB_OUTPUT"
  exit 0
fi

workflow="$(gh api "repos/$REPOSITORY/actions/runs/$RUN_ID" --jq .workflow_id)"
sha="$(gh api "repos/$REPOSITORY/actions/workflows/$workflow/runs?branch=$BRANCH&event=push&status=success&per_page=1" --jq '.workflow_runs[0].head_sha // ""')"
echo "sha=$sha" >> "$GITHUB_OUTPUT"
