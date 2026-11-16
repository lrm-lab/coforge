#!/usr/bin/env bash
# Ask the in-container supervisor to stop the running program and start the
# one selected on the data volume. The container itself stays up.
set -uo pipefail

supervisor="${COFORGE_RUNTIME_SUPERVISOR_PID:-1}"
pidfile="${COFORGE_RUNTIME_PIDFILE:-/run/coforge-runtime.pid}"

log() { echo "[restart-computer-runtime] $*" >&2; }

cmd="$(tr '\0' ' ' < "/proc/${supervisor}/cmdline" 2>/dev/null || true)"
case "${cmd}" in
  *supervise-computer-runtime.sh*) ;;
  *)
    log "pid ${supervisor} is not the runtime supervisor"
    exit 2
    ;;
esac

old="$(tr -d '[:space:]' < "${pidfile}" 2>/dev/null || true)"
kill -USR1 "${supervisor}"
for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  new="$(tr -d '[:space:]' < "${pidfile}" 2>/dev/null || true)"
  if [[ -n "${new}" && "${new}" != "${old}" ]] && kill -0 "${new}" 2>/dev/null; then
    log "restarted ${old:-none} -> ${new}"
    exit 0
  fi
  sleep 0.2
done
log "runtime did not restart"
exit 1
