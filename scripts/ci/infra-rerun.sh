#!/usr/bin/env bash
# Rerun a completed workflow run's failed jobs once, but only when every failed
# step is an infrastructure step — tool downloads, registry logins, browser
# installs — the flakes that turned whole runs red (task #38). A real check
# failure keeps its own step name, so mixed runs are left alone, and
# run_attempt caps this at one rerun per run.
# Usage: infra-rerun.sh <run-id>   (env: GH_TOKEN, REPO)
set -euo pipefail

run_id=${1:?usage: infra-rerun.sh <run-id>}
: "${REPO:?}" "${GH_TOKEN:?}"

run="$(gh api "repos/$REPO/actions/runs/$run_id")"
conclusion="$(jq -r '.conclusion // empty' <<<"$run")"
attempt="$(jq -r '.run_attempt // 0' <<<"$run")"

if [ "$conclusion" != "failure" ]; then
  echo "run $run_id conclusion is '${conclusion:-none}', not failure; nothing to do"
  exit 0
fi
if [ "$attempt" != "1" ]; then
  echo "run $run_id is already on attempt $attempt; one rerun was the cap"
  exit 0
fi

jobs="$(gh api "repos/$REPO/actions/runs/$run_id/jobs?filter=latest&per_page=100")"
failed_steps="$(jq -r '[.jobs[] | select(.conclusion == "failure") | .steps[]? | select(.conclusion == "failure") | .name] | .[]' <<<"$jobs")"

if [ -z "$failed_steps" ]; then
  echo "run $run_id failed but no job reports a failed step; leaving it"
  exit 0
fi

# Step names that only fetch tools, log in to registries, or install browsers —
# never a check of the repository's own code.
infra='^(Set up mise|Install pinned .+|Install toolchain|Install agent-browser and Chrome|Log in to (GitHub Container Registry|the image registry))$'
noninfra="$(grep -vEi "$infra" <<<"$failed_steps" || true)"
if [ -n "$noninfra" ]; then
  echo "run $run_id has failed steps outside the infrastructure list; not rerunning:"
  while IFS= read -r step; do echo "  - $step"; done <<<"$noninfra"
  exit 0
fi

echo "run $run_id failed only on infrastructure steps:"
while IFS= read -r step; do echo "  - $step"; done <<<"$failed_steps"
echo "rerunning its failed jobs once"
gh run rerun "$run_id" --repo "$REPO" --failed
