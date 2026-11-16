#!/usr/bin/env bash
# Install one published coforge-computer onto the data volume and point active at it.
# The container restarts separately; the entrypoint then runs this copy.
set -euo pipefail

version="${1:-}"
feed="${COFORGE_RELEASE_FEED_URL:-}"
feed="${feed%/}"
VOLUME="${COFORGE_PERSIST_ROOT:-/root/.coforge}"
INSTALL="${COFORGE_COMPUTER_INSTALL_ROOT:-${VOLUME}/computer/install}"

log() { echo "[activate-computer-release] $*" >&2; }

if [[ -z "${feed}" ]]; then
  log "COFORGE_RELEASE_FEED_URL is not set (bake it at image build or pass at runtime)"
  exit 1
fi
if [[ ! "${version}" =~ ^[A-Za-z0-9.+-]{1,100}$ ]] || [[ "${version}" == "." ]] || [[ "${version}" == -* ]] || [[ "${version}" == *..* ]]; then
  log "refusing version"
  exit 1
fi
if [[ ! -d "${VOLUME}" ]]; then
  log "volume ${VOLUME} is missing"
  exit 1
fi

if [[ -f "${INSTALL}/active.json" ]] && grep -q "\"current\":\"${version}\"" "${INSTALL}/active.json" && [[ -x "${INSTALL}/active/coforge-computer" ]]; then
  log "already active ${version}"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
curl -fL --retry 3 -o "${tmp}/coforge-computer.gz" "${feed}/${version}/linux-x64/coforge-computer.gz"
curl -fsSL -o "${tmp}/coforge-computer.sha256" "${feed}/${version}/linux-x64/coforge-computer.sha256"
gzip -dc "${tmp}/coforge-computer.gz" > "${tmp}/coforge-computer"
expected="$(tr -d '[:space:]' < "${tmp}/coforge-computer.sha256")"
actual="$(sha256sum "${tmp}/coforge-computer" | awk '{print $1}')"
if [[ "${actual}" != "${expected}" ]]; then
  log "checksum mismatch"
  exit 1
fi
chmod 755 "${tmp}/coforge-computer"

mkdir -p "${INSTALL}/versions"
dest="${INSTALL}/versions/${version}"
rm -rf "${dest}"
mkdir -p "${dest}"
cp -a "${tmp}/coforge-computer" "${dest}/coforge-computer"
printf '%s\n' '#!/bin/sh' 'exec "${0%/*}/coforge-computer" __agent-cli "$@"' > "${dest}/coforge"
chmod 755 "${dest}/coforge"
printf '%s\n' "${version}" > "${dest}/version"
chmod 600 "${dest}/version"

identity() {
  local path="$1" size checksum
  size="$(stat -c%s "${path}")"
  checksum="$(sha256sum "${path}" | awk '{print $1}')"
  printf '{"size": %s, "checksum": "%s"}' "${size}" "${checksum}"
}
cat > "${dest}/installation.json" <<EOF
{
  "schema_version": 2,
  "version": "${version}",
  "computer": $(identity "${dest}/coforge-computer"),
  "agentCli": $(identity "${dest}/coforge")
}
EOF
chmod 600 "${dest}/installation.json"

previous="null"
if [[ -f "${INSTALL}/active.json" ]]; then
  current="$(sed -n 's/.*"current":"\([^"]*\)".*/\1/p' "${INSTALL}/active.json")"
  if [[ -n "${current}" && "${current}" != "${version}" ]]; then
    previous="\"${current}\""
  fi
fi
ln -sfn "versions/${version}" "${INSTALL}/active"
cat > "${INSTALL}/active.json" <<EOF
{"schema_version":1,"current":"${version}","previous":${previous}}
EOF
chmod 600 "${INSTALL}/active.json"
log "activated ${version}"
