#!/usr/bin/env bash
# Keep enabled Workspaces running after image replace / Daemon recovery gaps.
# coforge-computer foreground recovers bindings once at start; if that handshake
# misses, the Workspace stays down until an operator start. This loop fills that
# gap. Parked Workspaces are never touched.
set -uo pipefail

SELECT="${COFORGE_SELECT_COMPUTER_BIN:-/usr/local/bin/select-computer-binary.sh}"
IMAGE_BIN="${COFORGE_IMAGE_COMPUTER_BIN:-/usr/local/bin/coforge-computer}"
INTERVAL="${COFORGE_WORKSPACE_WATCH_INTERVAL:-45}"
GRACE="${COFORGE_WORKSPACE_WATCH_GRACE:-90}"
BACKOFF="${COFORGE_WORKSPACE_WATCH_BACKOFF:-120}"
ENABLED="${COFORGE_WORKSPACE_WATCH:-1}"

log() { echo "[watch-computer-workspaces] $*" >&2; }

if [[ "${ENABLED}" == "0" ]]; then
  log "disabled (COFORGE_WORKSPACE_WATCH=0)"
  exit 0
fi

choose_bin() {
  local selected="${IMAGE_BIN}" picked=""
  if [[ -x "${SELECT}" ]]; then
    if picked="$("${SELECT}" 2>/dev/null)"; then
      [[ -n "${picked}" && -x "${picked}" ]] && selected="${picked}"
    fi
  fi
  printf '%s\n' "${selected}"
}

# Print workspace ids that need a start: enabled, not parked, and either not
# running or cloud not connected. Empty when nothing to do / status unreadable.
needs_start() {
  local bin="$1"
  local json=""
  json="$("${bin}" status --json 2>/dev/null)" || return 0
  python3 - "$json" <<'PY'
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
ws = (data.get("workspaces") or {}).get("workspaces") or []
for item in ws:
    if not item.get("enabled"):
        continue
    health = item.get("health") or {}
    if health.get("status") == "parked":
        continue
    cloud = ((item.get("cloudConnection") or {}).get("state") or "")
    running = bool(item.get("running"))
    if running and cloud == "connected":
        continue
    # Still connecting after a fresh start — give it another interval.
    if running and cloud in ("connecting", "unknown", ""):
        # Only nudge if there is a last-failure style signal via health degraded,
        # or if not connected for long; keep simple: retry when not connected.
        if cloud == "connecting":
            continue
    wid = item.get("workspaceId")
    if isinstance(wid, str) and wid:
        print(wid)
PY
}

log "grace ${GRACE}s then every ${INTERVAL}s (backoff ${BACKOFF}s after start)"
sleep "${GRACE}"

while true; do
  bin="$(choose_bin)"
  if [[ ! -x "${bin}" ]]; then
    log "no computer binary yet; sleep ${INTERVAL}s"
    sleep "${INTERVAL}"
    continue
  fi
  # Daemon socket may not exist until foreground is up.
  if [[ ! -S /root/.coforge/daemon/daemon.sock ]]; then
    sleep "${INTERVAL}"
    continue
  fi
  mapfile -t ids < <(needs_start "${bin}" || true)
  if [[ "${#ids[@]}" -eq 0 ]]; then
    sleep "${INTERVAL}"
    continue
  fi
  for wid in "${ids[@]}"; do
    [[ -n "${wid}" ]] || continue
    log "workspace ${wid} down; running start"
    if "${bin}" start --workspace "${wid}" >/tmp/watch-computer-start.log 2>&1; then
      log "start ok for ${wid}"
    else
      # Unscoped start still clears latches when --workspace is rejected as
      # "not registered" after a stop left enabled=false briefly.
      log "scoped start failed for ${wid}; trying unscoped start"
      "${bin}" start >/tmp/watch-computer-start.log 2>&1 || \
        log "start failed for ${wid}: $(tr '\n' ' ' </tmp/watch-computer-start.log | head -c 400)"
    fi
  done
  sleep "${BACKOFF}"
done
