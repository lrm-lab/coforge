#!/usr/bin/env bash
# Re-run a command with exponential backoff for flaky external downloads
# (GitHub releases, registries) that outlast a single attempt (task #38).
# Usage: retry.sh <attempts> <initial-delay-seconds> -- <command> [args...]
set -uo pipefail

if [ "$#" -lt 4 ] || [ "$3" != "--" ]; then
  echo "usage: $0 <attempts> <delay-seconds> -- <command> [args...]" >&2
  exit 2
fi

attempts=$1
delay=$2
shift 3

codes=()
for ((attempt = 1; attempt <= attempts; attempt++)); do
  if "$@"; then
    exit 0
  else
    rc=$?
  fi
  codes+=("$rc")
  if [ "$attempt" -eq "$attempts" ]; then
    echo "retry.sh: command failed $attempts times (exits: ${codes[*]}): $*" >&2
    exit "$rc"
  fi
  echo "retry.sh: attempt $attempt/$attempts failed (exit $rc); retrying in ${delay}s" >&2
  sleep "$delay"
  delay=$((delay * 2))
done
