#!/usr/bin/env bash
# Pick the Computer binary for this container.
#
# Preference:
# 1. Volume active when it is at least as new as the image-baked version
#    (OTA runtime upgrades stay in effect).
# 2. Image binary when it is newer than volume active (image replace promotes
#    without a second runtime upgrade).
# 3. Empty volume is seeded from the image into versions/<version> + active.json.
# 4. Image binary remains the fallback when the volume cannot be used.
set -euo pipefail

IMAGE_BIN="${COFORGE_IMAGE_COMPUTER_BIN:-/usr/local/bin/coforge-computer}"
VOLUME="${COFORGE_PERSIST_ROOT:-/root/.coforge}"
INSTALL="${COFORGE_COMPUTER_INSTALL_ROOT:-${VOLUME}/computer/install}"
VERSION_FILE="${COFORGE_COMPUTER_VERSION_FILE:-/usr/local/share/coforge/computer-version}"

log() { echo "[select-computer-binary] $*" >&2; }

valid_version() {
  local version="$1"
  [[ "${version}" =~ ^[A-Za-z0-9.+-]{1,100}$ ]] \
    && [[ "${version}" != "." ]] \
    && [[ "${version}" != -* ]] \
    && [[ "${version}" != *..* ]]
}

# True when $1 is strictly newer than $2. Equal → false.
# Semver-ish: release > pre-release for the same X.Y.Z (sort -V is wrong here).
version_gt() {
  local newer="$1"
  local older="$2"
  [[ "${newer}" == "${older}" ]] && return 1
  python3 - "$newer" "$older" <<'PY'
import re, sys

def parts(v: str):
    v = v.lstrip("vV")
    m = re.match(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.](.+))?$", v)
    if not m:
        return None
    core = (int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0))
    pre = m.group(4)
    if pre is None:
        return core, ()
    bits = []
    for bit in re.split(r"[.-]", pre):
        if bit.isdigit():
            bits.append((0, int(bit)))
        else:
            bits.append((1, bit))
    return core, tuple(bits)

a, b = parts(sys.argv[1]), parts(sys.argv[2])
if a is None or b is None:
    sys.exit(1)
# Larger core wins. Same core: empty pre (release) > any pre-release.
if a[0] != b[0]:
    sys.exit(0 if a[0] > b[0] else 1)
if a[1] == () and b[1] != ():
    sys.exit(0)
if a[1] != () and b[1] == ():
    sys.exit(1)
sys.exit(0 if a[1] > b[1] else 1)
PY
}
identity_json() {
  local path="$1"
  local size checksum
  size="$(stat -c%s "${path}")"
  checksum="$(sha256sum "${path}" | awk '{print $1}')"
  printf '{"size": %s, "checksum": "%s"}' "${size}" "${checksum}"
}

read_active_current() {
  local current=""
  if [[ -f "${INSTALL}/active.json" ]]; then
    current="$(sed -n 's/.*"current":"\([^"]*\)".*/\1/p' "${INSTALL}/active.json" | head -n1)"
  fi
  printf '%s\n' "${current}"
}

# coforge-daemon-boot.sh used to make active/ a directory whose binary is a
# symlink back to the image. That is not an installer activation.
legacy_image_link() {
  [[ -d "${INSTALL}/active" && ! -L "${INSTALL}/active" ]] || return 1
  [[ -L "${INSTALL}/active/coforge-computer" ]] || return 1
  local target image
  target="$(readlink -f "${INSTALL}/active/coforge-computer" 2>/dev/null || true)"
  image="$(readlink -f "${IMAGE_BIN}" 2>/dev/null || true)"
  [[ -n "${target}" && "${target}" == "${image}" ]]
}

# Write versions/<version> from IMAGE_BIN and point active at it.
# previous_json is null or a JSON string like "1.2.3".
install_image_version() {
  local version="$1"
  local previous_json="${2:-null}"
  local dest="${INSTALL}/versions/${version}"

  if [[ -e "${INSTALL}/active" ]] && ! [[ -L "${INSTALL}/active" ]]; then
    if legacy_image_link; then
      rm -rf "${INSTALL}/active"
    else
      log "refuse install: ${INSTALL}/active is not a symlink"
      return 1
    fi
  fi

  mkdir -p "${INSTALL}/versions"
  local stage
  stage="$(mktemp -d "${INSTALL}/versions/.seed.XXXXXX")"
  cp -a "${IMAGE_BIN}" "${stage}/coforge-computer"
  chmod 755 "${stage}/coforge-computer"
  printf '%s\n' '#!/bin/sh' 'exec "${0%/*}/coforge-computer" __agent-cli "$@"' > "${stage}/coforge"
  chmod 755 "${stage}/coforge"
  printf '%s\n' "${version}" > "${stage}/version"
  chmod 600 "${stage}/version"
  cat > "${stage}/installation.json" <<EOF
{
  "schema_version": 2,
  "version": "${version}",
  "computer": $(identity_json "${stage}/coforge-computer"),
  "agentCli": $(identity_json "${stage}/coforge")
}
EOF
  chmod 600 "${stage}/installation.json"
  rm -rf "${dest}"
  mv "${stage}" "${dest}"
  ln -sfn "versions/${version}" "${INSTALL}/active"
  cat > "${INSTALL}/active.json" <<EOF
{"schema_version":1,"current":"${version}","previous":${previous_json}}
EOF
  chmod 600 "${INSTALL}/active.json"
}

seed_image_version() {
  local version="$1"
  if [[ -e "${INSTALL}/active.json" ]]; then
    return 0
  fi
  if [[ -e "${INSTALL}/versions/${version}" ]]; then
    return 0
  fi
  if [[ -e "${INSTALL}/active" ]]; then
    if legacy_image_link; then
      rm -rf "${INSTALL}/active"
    else
      log "leave existing ${INSTALL}/active in place"
      return 0
    fi
  fi
  install_image_version "${version}" "null"
  log "seeded ${version} from the image"
}

promote_image_if_newer() {
  local image_version="$1"
  local current
  current="$(read_active_current)"
  if [[ -z "${current}" ]]; then
    return 0
  fi
  if ! valid_version "${current}"; then
    log "skip promote: active version is invalid (${current})"
    return 0
  fi
  if ! version_gt "${image_version}" "${current}"; then
    return 0
  fi
  install_image_version "${image_version}" "\"${current}\""
  log "promoted image ${image_version} over active ${current}"
}

activated="${INSTALL}/active/coforge-computer"
if [[ -d "${VOLUME}" && -x "${IMAGE_BIN}" && -f "${VERSION_FILE}" ]]; then
  version="$(tr -d '[:space:]' < "${VERSION_FILE}")"
  if valid_version "${version}"; then
    if [[ ! -e "${INSTALL}/active.json" ]]; then
      seed_image_version "${version}"
    else
      promote_image_if_newer "${version}"
    fi
  else
    log "skip seed/promote: image version is not a release version"
  fi
fi

if [[ -x "${activated}" && -f "${INSTALL}/active.json" ]]; then
  printf '%s\n' "${activated}"
  exit 0
fi

printf '%s\n' "${IMAGE_BIN}"
