#!/usr/bin/env bash
# Bind-mount persistent /workspace/skills onto the runtime Pi skills directory so
# newly created container-level skills land on the volume automatically.
#
# Requires mount privileges (normal for the cloud-computer image as root).
# Falls back silently when mount is unavailable — sync-pi-skills copy remains.
set -euo pipefail

log() { echo "[bind-pi-skills] $*"; }

WORKSPACE="${WORKSPACE:-/workspace}"
WORKSPACE_SKILLS="${PI_WORKSPACE_SKILLS:-${WORKSPACE}/skills}"
PI_HOME="${PI_HOME:-/root}"
AGENT_DIR="${PI_AGENT_DIR:-${PI_HOME}/.pi/agent}"
AGENT_SKILLS="${PI_AGENT_SKILLS:-${AGENT_DIR}/skills}"

mkdir -p "${WORKSPACE_SKILLS}" "${AGENT_SKILLS}"

if findmnt -n "${AGENT_SKILLS}" >/dev/null 2>&1; then
  src="$(findmnt -n -o SOURCE "${AGENT_SKILLS}" 2>/dev/null || true)"
  log "already mounted (${src:-unknown}) -> ${AGENT_SKILLS}"
  exit 0
fi

# Prefer emptying a plain directory left by sync so the bind covers the path.
if [[ -L "${AGENT_SKILLS}" ]]; then
  rm -f "${AGENT_SKILLS}"
  mkdir -p "${AGENT_SKILLS}"
fi

if ! mount --bind "${WORKSPACE_SKILLS}" "${AGENT_SKILLS}" 2>/tmp/bind-pi-skills.err; then
  log "WARN: mount --bind failed; skills stay as copied trees ($(tr '\n' ' ' </tmp/bind-pi-skills.err))"
  exit 0
fi

log "bound ${WORKSPACE_SKILLS} -> ${AGENT_SKILLS}"
