#!/usr/bin/env bash
# Exercise `validate-backfill-inputs.sh` against the cases task #465's review named — a local run
# so the workflow's input gate does not only get exercised on a real dispatch. Each case runs the
# validator with a clean env; expect() prints PASS/FAIL.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
VALIDATE="$DIR/validate-backfill-inputs.sh"
fails=0
expect() { # <name> <want 0|1> [KEY=value...]
  local name=$1 want=$2; shift 2
  env -i "$@" bash "$VALIDATE" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then echo "PASS $name"; else echo "FAIL $name (want $want got $got)"; fails=$((fails+1)); fi
}
expect "defaults pass" 0 MODE=dry-run
expect "uuid from-id passes" 0 FROM_ID=11111111-2222-3333-4444-555555555555 MODE=apply
expect "14 maxMinutes rejects" 1 MAX_MINUTES=14 MODE=apply
expect "a;id:5 batch rejects" 1 "BATCH_SIZE=a;id:5" MODE=apply
expect "batchSize=0 rejects" 1 BATCH_SIZE=0 MODE=apply
expect "maxMinutes=0 rejects" 1 MAX_MINUTES=0 MODE=apply
expect "pauseMs=0 passes" 0 PAUSE_MS=0 MODE=apply
expect "newline rejects" 1 "BATCH_SIZE=10
rm -rf" MODE=apply
expect "non-uuid runId rejects" 1 MODE=rollback RUN_ID=not-a-uuid
expect "uuid runId passes" 0 MODE=rollback RUN_ID=11111111-2222-3333-4444-555555555555
[ "$fails" -eq 0 ] && echo "all pass" || { echo "$fails failures"; exit 1; }
