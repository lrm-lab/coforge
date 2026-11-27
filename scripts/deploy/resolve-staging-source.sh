#!/usr/bin/env bash
set -euo pipefail

sha="$DISPATCH_SHA"
if [[ -n "$CANDIDATE_REF" ]]; then
  ref="$(jq -rn --arg ref "$CANDIDATE_REF" '$ref | @uri')"
  if ! sha="$(gh api "repos/$REPOSITORY/commits/$ref" --jq '.sha')"; then
    echo "Could not resolve the staging candidate in this repository." >&2
    exit 1
  fi
fi
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The staging candidate did not resolve to a full commit SHA." >&2
  exit 1
fi

query_verdict() {
  gh api "repos/$REPOSITORY/actions/workflows/ci.yml/runs?branch=main&head_sha=$sha&status=completed&per_page=20" |
    jq -r --arg sha "$sha" --arg repo "$REPOSITORY" '
      any(.workflow_runs[];
        .head_sha == $sha and .head_branch == "main" and .head_repository.full_name == $repo and
        (.event == "push" or .event == "workflow_dispatch") and
        .status == "completed" and .conclusion == "success")'
}
if ! passed="$(query_verdict)"; then
  if [[ -z "${FALLBACK_TO_VALIDATION:-}" ]]; then
    echo "Could not check CI for $sha." >&2
    exit 1
  fi
  passed=false
fi
if [[ -n "$CANDIDATE_REF" && "$passed" != true ]]; then
  echo "Staging candidate $sha needs a successful CI run on main for that exact commit." >&2
  exit 1
fi
printf 'sha=%s\npassed=%s\n' "$sha" "$passed" >> "$GITHUB_OUTPUT"
