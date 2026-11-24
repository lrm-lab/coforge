#!/usr/bin/env bash
# Runs the Web integration suites - the ones CI cannot run, because the jobs have no PostgreSQL, so
# nothing exercises them between a developer's machine and `main`.
#
# Their environment is the obstacle: each suite checks its own database or Redis test URL,
# so the set of names is only learnable one failure at a time. This points
# every one of them at one scratch database and one scratch redis. The list below is the truth about
# how many there are - a count in prose would rot, which is what the guard in scripts/ci is for.
#
#   INTEGRATION_DATABASE_URL=postgresql://coforge:test@127.0.0.1:15440/coforge \
#   INTEGRATION_REDIS_URL=redis://127.0.0.1:16379 \
#     mise run test:integration:web
#
# The defaults match that scratch stack. Apply migrations first, or every suite fails on a missing
# table:
#
#   DATABASE_URL=$INTEGRATION_DATABASE_URL bun run --cwd apps/web db:migrate:deploy
#
# Some suites need more than a database and skip or fail here without it: the Centrifugo-backed ones
# (COFORGE_CENTRIFUGO_API_URL/KEY), `production.integration.ts` (a built `.output/server`) and
# `github-connection.integration.ts` (a reachable GitHub). scripts/ci/integration-env.test.ts keeps
# the list below in step with the names the suites read, so a new area fails loudly at review time
# rather than at run time.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
database="${INTEGRATION_DATABASE_URL:-postgresql://coforge:test@127.0.0.1:15440/coforge}"
redis="${INTEGRATION_REDIS_URL:-redis://127.0.0.1:16379}"

export DATABASE_URL="$database"
export REDIS_URL="$redis"
# Every name the suites check, spelled out rather than built from an area loop, so that
# `grep _TEST_DATABASE_URL scripts/test/run-web-integration.sh` shows the whole set. The guard in
# scripts/ci/integration-env.test.ts keeps this in step with what the suites read.
for name in \
  AGENT_ACTIVITY_TEST_DATABASE_URL \
  AGENT_MIGRATION_TEST_DATABASE_URL \
  AGENT_SESSION_TEST_DATABASE_URL \
  APP_NOTIFICATIONS_TEST_DATABASE_URL \
  ATTACHMENT_UPLOAD_SESSION_TEST_DATABASE_URL \
  ATTACHMENT_DIMENSIONS_BACKFILL_TEST_DATABASE_URL \
  CHANNEL_TEST_DATABASE_URL \
  EVENTS_TEST_DATABASE_URL \
  GITHUB_COMMIT_TRAILERS_TEST_DATABASE_URL \
  GITHUB_TEST_DATABASE_URL \
  MIGRATION_TEST_DATABASE_URL \
  TEAM_MEMORY_TEST_DATABASE_URL \
  ONBOARDING_TEST_DATABASE_URL \
  PREFERENCES_TEST_DATABASE_URL \
  RELEASE_CATALOG_TEST_DATABASE_URL \
  REMINDER_TEST_DATABASE_URL \
  SERVER_LIFECYCLE_TEST_DATABASE_URL \
  SKILLS_TEST_DATABASE_URL \
  TASK_TEST_DATABASE_URL \
  THREAD_TEST_DATABASE_URL \
  USAGE_LIMIT_TEST_DATABASE_URL \
  WEEKLY_REPORT_TEST_DATABASE_URL; do
  export "$name=$database"
done
# The migration safety suites create and drop their own scratch databases on this server.
export MIGRATION_SAFETY_ADMIN_URL="${database%/*}/postgres"
export CHANNEL_TEST_REDIS_URL="$redis"
export SKILLS_TEST_REDIS_URL="$redis"
export MODEL_CATALOG_TEST_REDIS_URL="$redis"
export PI_CHAT_TEST_REDIS_URL="$redis"
export APP_RATE_LIMIT_TEST_REDIS_URL="$redis"
export APP_PRESENCE_TEST_REDIS_URL="$redis"
export AGENT_TURN_INTERRUPT_TEST_REDIS_URL="$redis"
export RUNTIME_AUTH_TEST_REDIS_URL="$redis"

files=()
if [ "$#" -gt 0 ]; then
  for arg in "$@"; do
    if [ -e "$arg" ]; then
      files+=("$(CDPATH='' cd -- "$(dirname -- "$arg")" && pwd)/$(basename -- "$arg")")
    else
      files+=("$arg")
    fi
  done
else
  for file in "$root"/apps/web/test/*.integration*.ts; do
    # A glob that matched nothing would leave `bun test` with no arguments, and it would then discover
    # and run every test in the package instead - a silent change of subject.
    [ -e "$file" ] || {
      printf 'No integration files matched under %s/apps/web/test.\n' "$root" >&2
      exit 1
    }
    files+=("$file")
  done
  files+=("$root"/scripts/migration-safety/*.integration.ts)
fi

cd "$root/apps/web"
unset COFORGE_SCRATCH_DATABASE_TEMPLATE COFORGE_SCRATCH_DATABASE_TEMPLATE_BASE_URL COFORGE_SCRATCH_DATABASE_CREATED_FILE
scratch_template="scratch_template_$(bun -e 'console.log(crypto.randomUUID().replaceAll("-", ""))')"
scratch_template_marker=$(mktemp)
active_child_pid=""
stop_active_child() {
  if [ -n "${active_child_pid:-}" ]; then
    local pid="$active_child_pid"
    active_child_pid=""
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}
run_cancellable() {
  "$@" &
  active_child_pid=$!
  local status=0
  wait "$active_child_pid" || status=$?
  active_child_pid=""
  return "$status"
}
cleanup_scratch_template() {
  local exit_code=$?
  trap '' INT TERM
  stop_active_child
  if [ -n "${scratch_template_marker:-}" ] && [ -f "$scratch_template_marker" ]; then
    local marker="$scratch_template_marker"
    scratch_template_marker=""
    local drop_status=0
    if [ -s "$marker" ]; then
      bun "$root/apps/web/test/support/scratch-database.ts" cleanup "$marker" || drop_status=$?
    fi
    rm -f "$marker"
    if [ "$exit_code" -eq 0 ] && [ "$drop_status" -ne 0 ]; then
      exit "$drop_status"
    fi
  fi
  exit "$exit_code"
}
handle_signal() {
  local code="$1"
  trap '' INT TERM
  stop_active_child
  exit "$code"
}
trap cleanup_scratch_template EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

export COFORGE_SCRATCH_DATABASE_CREATED_FILE="$scratch_template_marker"
run_cancellable bun "$root/apps/web/test/support/scratch-database.ts" prepare "$scratch_template"
export COFORGE_SCRATCH_DATABASE_TEMPLATE="$scratch_template"
export COFORGE_SCRATCH_DATABASE_TEMPLATE_BASE_URL="$database"

run_cancellable bun test --preload ./test/web-integration-queue.preload.ts "${files[@]}"
