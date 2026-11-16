#!/usr/bin/env bash
# Stay as the container's main process and run coforge-computer as a child.
# A runtime upgrade signals this process; the child is replaced and the
# container keeps the same desktop listeners.
set -uo pipefail

SELECT="${COFORGE_SELECT_COMPUTER_BIN:-/usr/local/bin/select-computer-binary.sh}"
IMAGE_BIN="${COFORGE_IMAGE_COMPUTER_BIN:-/usr/local/bin/coforge-computer}"
PIDFILE="${COFORGE_RUNTIME_PIDFILE:-/run/coforge-runtime.pid}"
RESTART_DELAY="${COFORGE_RUNTIME_RESTART_DELAY:-1}"

log() { echo "[supervise-computer-runtime] $*" >&2; }

child=""
reload=0
stopping=0

choose_bin() {
  local selected="${IMAGE_BIN}"
  local picked=""
  if [[ -x "${SELECT}" ]]; then
    if picked="$("${SELECT}")"; then
      if [[ -n "${picked}" && -x "${picked}" ]]; then
        selected="${picked}"
      fi
    else
      log "selector failed; using ${selected}"
    fi
  fi
  printf '%s\n' "${selected}"
}

write_pid() {
  local dir
  dir="$(dirname "${PIDFILE}")"
  mkdir -p "${dir}" 2>/dev/null || true
  printf '%s\n' "$1" > "${PIDFILE}" 2>/dev/null || true
}

start_child() {
  local bin
  bin="$(choose_bin)"
  log "start ${bin}"
  "${bin}" foreground &
  child=$!
  write_pid "${child}"
}

stop_child() {
  local pid="${child}"
  [[ -n "${pid}" ]] || return 0
  if kill -0 "${pid}" 2>/dev/null; then
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    local _i
    for _i in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "${pid}" 2>/dev/null; then
      kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
    fi
  fi
  wait "${pid}" 2>/dev/null || true
  child=""
}

on_reload() { reload=1; }
on_stop() {
  stopping=1
  local pid="${child}"
  if [[ -n "${pid}" ]]; then
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  fi
}

set -m
trap on_reload USR1
trap on_stop TERM INT

start_child

while [[ "${stopping}" -eq 0 ]]; do
  finished=""
  status=0
  wait -n -p finished || status=$?
  if [[ "${stopping}" -eq 1 ]]; then
    break
  fi
  if [[ "${reload}" -eq 1 ]]; then
    reload=0
    if [[ -n "${child}" && "${finished-}" != "${child}" ]]; then
      stop_child
    else
      child=""
    fi
    start_child
    continue
  fi
  if [[ -z "${finished-}" || "${status}" -gt 128 ]]; then
    continue
  fi
  if [[ "${finished-}" != "${child}" ]]; then
    continue
  fi
  log "child exited ${status}"
  child=""
  if [[ "${RESTART_DELAY}" != "0" ]]; then
    sleep "${RESTART_DELAY}"
  fi
  if [[ "${stopping}" -eq 0 && "${reload}" -eq 0 ]]; then
    start_child
  fi
done

stop_child
rm -f "${PIDFILE}" 2>/dev/null || true
