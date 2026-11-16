#!/usr/bin/env bash
# Smoke-test workspace persist (keep inode / merge) + venv create.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

export COFORGE_PERSIST_ROOT="${TMP}/coforge"
mkdir -p "${COFORGE_PERSIST_ROOT}"

WORK="${TMP}/overlay-workspace"
STORE="${COFORGE_PERSIST_ROOT}/workspace"
mkdir -p "${WORK}/uploads" "${STORE}/keep-me"
echo old > "${STORE}/keep-me/file.txt"
echo new > "${WORK}/fresh.txt"

# Mirror the non-destructive clear + bind/symlink intent without needing root mount.
persist_workspace_safe() {
  local live="$1"
  local store="$2"
  mkdir -p "${store}/uploads" "${store}/browser-shots"
  if [[ -d "${live}" && ! -L "${live}" ]]; then
    if [[ -n "$(ls -A "${live}" 2>/dev/null || true)" ]]; then
      cp -a "${live}/." "${store}/"
    fi
    # Keep directory inode (critical vs rm -rf live).
    find "${live}" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  fi
  # Simulate bind by symlinking contents... for the test we only assert inode kept
  # and store merged. Recreate a marker file inside live to prove inode survived.
  echo survived > "${live}/.inode-ok"
  [[ -d "${live}" && ! -L "${live}" ]] || return 1
  [[ -f "${store}/keep-me/file.txt" ]] || return 1
  [[ -f "${store}/fresh.txt" ]] || return 1
}

persist_workspace_safe "${WORK}" "${STORE}"
[[ -f "${WORK}/.inode-ok" ]] || { echo "FAIL: directory inode was removed"; exit 1; }
[[ -f "${STORE}/keep-me/file.txt" ]] || { echo "FAIL: store wiped"; exit 1; }
[[ -f "${STORE}/fresh.txt" ]] || { echo "FAIL: merge missed overlay file"; exit 1; }

# Empty overlay again must not wipe store.
find "${WORK}" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
persist_workspace_safe "${WORK}" "${STORE}"
[[ -f "${STORE}/keep-me/file.txt" ]] || { echo "FAIL: empty overlay wiped store"; exit 1; }

if python3 -c "import venv" 2>/dev/null; then
  VENV="${COFORGE_PERSIST_ROOT}/venv"
  python3 -m venv --system-site-packages "${VENV}"
  [[ -x "${VENV}/bin/pip" ]] || { echo "FAIL: venv pip missing"; exit 1; }
  echo "venv ok"
else
  echo "skip venv: python3-venv unavailable on host"
fi

# Entrypoint must cd off /workspace before persist.
grep -q 'cd / || true' "${ROOT}/scripts/entrypoint-foreground.sh"
grep -q 'never `rm -rf /workspace`' "${ROOT}/scripts/persist-user-data.sh" \
  || grep -q 'never.*rm -rf /workspace' "${ROOT}/scripts/persist-user-data.sh"

echo "OK persist workspace + venv smoke"
