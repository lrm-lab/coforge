#!/usr/bin/env bash
# Validate the `backfill-message-references` workflow_dispatch inputs before any of them reaches
# the remote SSH/docker command (task #465): a uuid-shaped fromMessageId/runId, non-negative
# integer batch/pause, maxMinutes<=13, and a newline anywhere refused — it would split into a
# second remote command. Reads the same env the workflow exports. Exits nonzero on a bad input.
set -euo pipefail
uuid='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
posint='^[0-9]+$'
# A value containing a newline would split into a second command on the remote shell — refuse it
# before anything leaves the runner.
for value in "${FROM_ID:-}" "${BATCH_SIZE:-}" "${MAX_MINUTES:-}" "${PAUSE_MS:-}" "${RUN_ID:-}"; do
  if [[ $value == *$'\n'* ]]; then
    echo "an input contained a newline" >&2; exit 1; fi
done
[ -n "${FROM_ID:-}" ] && ! [[ ${FROM_ID} =~ $uuid ]] && { echo "fromMessageId must be a uuid" >&2; exit 1; }
for pair in "batchSize:${BATCH_SIZE:-}" "maxMinutes:${MAX_MINUTES:-}"; do
  name=${pair%%:*}; value=${pair#*:}
  { [ -n "$value" ] && ! [[ $value =~ $posint ]]; } || [ "$value" = "0" ] &&
    { echo "$name must be a positive integer" >&2; exit 1; }
done
[ -n "${PAUSE_MS:-}" ] && ! [[ ${PAUSE_MS} =~ $posint ]] &&
  { echo "pauseMs must be a non-negative integer" >&2; exit 1; }
[ -n "${MAX_MINUTES:-}" ] && [ "${MAX_MINUTES}" -gt 13 ] && { echo "maxMinutes must be <= 13" >&2; exit 1; }
if [ "${MODE:-}" = rollback ] && ! [[ ${RUN_ID:-} =~ $uuid ]]; then
  echo "rollback requires runId (a uuid), got '${RUN_ID:-}'" >&2; exit 1; fi
echo "inputs validated"
