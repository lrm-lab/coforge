#!/usr/bin/env bash
# Keep user-installed software, /workspace, and a Python venv on the Computer
# volume (/root/.coforge) so replacing the image does not drop them.
#
# If /opt is already a Docker volume, writes there persist with no extra work.
# Otherwise this script moves /opt trees onto the volume and keeps a watcher
# running so installers that replace a symlink are pulled back without the user
# doing anything.
set -euo pipefail

log() { echo "[persist-user-data] $*"; }

VOLUME="${COFORGE_PERSIST_ROOT:-/root/.coforge}"
APPS="${VOLUME}/apps"
HOME_STORE="${VOLUME}/home"
WORKSPACE_STORE="${VOLUME}/workspace"
VENV="${VOLUME}/venv"
VENV_STAMP="${VENV}/.coforge-python-version"

opt_is_volume() { mountpoint -q /opt 2>/dev/null; }

persist_one() {
  local live="$1"
  local store="$2"

  mkdir -p "$(dirname "${store}")" "$(dirname "${live}")"

  if [[ -L "${live}" ]]; then
    local dest
    dest="$(readlink -n "${live}" || true)"
    if [[ "${dest}" == "${store}" ]]; then
      return 0
    fi
    if [[ -e "${store}" || -d "${store}" ]]; then
      rm -f "${live}"
      ln -sfn "${store}" "${live}"
      log "relink ${live} -> ${store}"
    fi
    return 0
  fi

  if [[ -e "${live}" && ( -e "${store}" || -L "${store}" ) ]]; then
    # Installer unpacked onto overlay after a previous persist. Keep that copy.
    rm -rf "${store}"
    mv "${live}" "${store}"
    ln -sfn "${store}" "${live}"
    log "captured ${live} -> ${store}"
    return 0
  fi

  if [[ -e "${store}" || -L "${store}" ]]; then
    ln -sfn "${store}" "${live}"
    log "link ${live} -> ${store}"
    return 0
  fi

  if [[ -e "${live}" ]]; then
    mv "${live}" "${store}"
    ln -sfn "${store}" "${live}"
    log "moved ${live} -> ${store}"
  fi
}

ensure_home() {
  local name="$1"
  local live="/root/${name}"
  local store="${HOME_STORE}/${name}"
  if [[ ! -e "${store}" && ! -L "${store}" && ! -e "${live}" && ! -L "${live}" ]]; then
    mkdir -p "${store}"
    ln -sfn "${store}" "${live}"
    return 0
  fi
  persist_one "${live}" "${store}"
}

persist_home() {
  ensure_home "projects"
  ensure_home "Desktop"
  ensure_home "Downloads"
  ensure_home "Documents"
  ensure_home ".local"
  ensure_home ".xwechat"
  persist_one "/root/xwechat_files" "${HOME_STORE}/xwechat_files"

  if [[ -d /root/.config ]]; then
    persist_one "/root/.config/xfce4" "${HOME_STORE}/.config/xfce4"
    shopt -s nullglob
    for cfg in /root/.config/*wechat* /root/.config/*WeChat* /root/.config/weixin*; do
      [[ -e "${cfg}" || -L "${cfg}" ]] || continue
      persist_one "${cfg}" "${HOME_STORE}/.config/$(basename "${cfg}")"
    done
    shopt -u nullglob
  fi
}

# /workspace must prefer volume data. The image ships an empty /workspace; the
# generic persist_one "both exist → keep live" path would wipe the store.
#
# IMPORTANT: never `rm -rf /workspace`. The image WORKDIR is /workspace, so PID 1
# already has that cwd; deleting the directory inode makes every child shell
# fail with getcwd() "No such file or directory".
persist_workspace() {
  local live="/workspace"
  local store="${WORKSPACE_STORE}"

  mkdir -p "${store}/uploads" "${store}/browser-shots"

  # Already bind-mounted onto the store (same inode).
  if mountpoint -q "${live}" 2>/dev/null; then
    if [[ "$(stat -c '%d:%i' "${live}" 2>/dev/null || true)" == "$(stat -c '%d:%i' "${store}" 2>/dev/null || true)" ]]; then
      mkdir -p "${live}/uploads" "${live}/browser-shots"
      return 0
    fi
  fi

  # Convert a previous symlink layout into a real directory for bind-mount.
  if [[ -L "${live}" ]]; then
    rm -f "${live}"
    mkdir -p "${live}"
  fi

  if [[ -d "${live}" && ! -L "${live}" ]] && ! mountpoint -q "${live}" 2>/dev/null; then
    if [[ -n "$(ls -A "${live}" 2>/dev/null || true)" ]]; then
      if [[ "$(stat -c '%d:%i' "${live}" 2>/dev/null || true)" != "$(stat -c '%d:%i' "${store}" 2>/dev/null || true)" ]]; then
        cp -a "${live}/." "${store}/"
        log "merged ${live} into ${store}"
      fi
    fi
    # Clear contents only — keep the directory inode for existing cwd holders.
    find "${live}" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  elif [[ ! -e "${live}" ]]; then
    mkdir -p "${live}"
  fi

  if mount --bind "${store}" "${live}" 2>/dev/null; then
    mkdir -p "${live}/uploads" "${live}/browser-shots"
    log "workspace bind-mounted from ${store}"
    return 0
  fi

  # Fallback when bind mounts are denied: symlink. Callers must cd off
  # /workspace before invoking this script (see entrypoint-foreground.sh).
  log "bind mount failed; falling back to symlink"
  # Cannot symlink over a non-empty/real dir without replacing it; move aside.
  if [[ -d "${live}" && ! -L "${live}" ]] && ! mountpoint -q "${live}" 2>/dev/null; then
    local aside
    aside="${live}.aside.$$"
    mv "${live}" "${aside}"
    ln -sfn "${store}" "${live}"
    rm -rf "${aside}"
  else
    ln -sfn "${store}" "${live}"
  fi
  mkdir -p "${store}/uploads" "${store}/browser-shots"
  log "workspace -> ${store} (symlink)"
}

ensure_venv() {
  # Always use the real interpreter — never /usr/local/bin/python3 wrappers.
  local py=/usr/bin/python3
  if [[ ! -x "${py}" ]]; then
    log "skip venv: ${py} missing"
    return 0
  fi
  if ! "${py}" -c "import venv" 2>/dev/null; then
    log "skip venv: python3-venv unavailable"
    return 0
  fi

  local cur
  cur="$("${py}" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"

  # Detect a broken venv whose python symlinks back into /usr/local/bin wrappers
  # (causes /bin/sh ↔ venv python exec loops at 100% CPU).
  local broken=0
  if [[ -L "${VENV}/bin/python3" || -e "${VENV}/bin/python3" ]]; then
    local resolved
    resolved="$(readlink -f "${VENV}/bin/python3" 2>/dev/null || true)"
    case "${resolved}" in
      /usr/local/bin/python|/usr/local/bin/python3|"${VENV}/bin/python3") broken=1 ;;
    esac
    # Wrapper script mistakenly installed as the venv python.
    if [[ -f "${VENV}/bin/python3" ]] && head -1 "${VENV}/bin/python3" 2>/dev/null | grep -q '^#!/bin/sh'; then
      broken=1
    fi
  fi

  if [[ -x "${VENV}/bin/python" ]]; then
    local old=""
    if [[ -f "${VENV_STAMP}" ]]; then
      old="$(tr -d '[:space:]' < "${VENV_STAMP}" || true)"
    fi
    if [[ -n "${old}" && "${old}" != "${cur}" ]]; then
      log "python ${old} -> ${cur}; rebuilding ${VENV}"
      rm -rf "${VENV}"
    elif [[ "${broken}" -eq 1 ]]; then
      log "broken venv python link (${resolved:-unknown}); rebuilding ${VENV}"
      rm -rf "${VENV}"
    fi
  fi

  if [[ ! -x "${VENV}/bin/python" ]]; then
    # system-site-packages: keep image-baked pypdf/pptx visible inside the venv
    "${py}" -m venv --system-site-packages "${VENV}"
    printf '%s\n' "${cur}" > "${VENV_STAMP}"
    log "created ${VENV} (python ${cur})"
  fi

  # Point venv interpreters at /usr/bin so future /usr/local wrappers cannot loop.
  ln -sfn /usr/bin/python3 "${VENV}/bin/python3"
  ln -sfn python3 "${VENV}/bin/python"
  if [[ -x /usr/bin/python3.12 ]]; then
    ln -sfn /usr/bin/python3.12 "${VENV}/bin/python3.12" 2>/dev/null || true
  fi

  # Default PyPI is often unreachable from this network; pin a fast mirror.
  # Agents that run bare `pip install playwright` otherwise appear to hang.
  local pip_index="${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"
  local pip_host="${PIP_TRUSTED_HOST:-mirrors.aliyun.com}"
  mkdir -p "${VENV}/pip" /etc
  cat > "${VENV}/pip.conf" <<EOF
[global]
index-url = ${pip_index}
trusted-host = ${pip_host}
timeout = 60
EOF
  # venv pip reads \$VIRTUAL_ENV/pip.conf when set; also drop a system default.
  if [[ ! -f /etc/pip.conf ]]; then
    cp "${VENV}/pip.conf" /etc/pip.conf
  fi
  # Ensure pip inside the venv uses this file even without VIRTUAL_ENV.
  mkdir -p /root/.config/pip
  cp "${VENV}/pip.conf" /root/.config/pip/pip.conf

  # Login / interactive shells — PATH only (do NOT overwrite /usr/local/bin/python3;
  # that path is what venv historically linked to and wrapping it causes a loop).
  cat > /etc/profile.d/coforge-venv.sh <<EOF
# Managed by persist-user-data.sh — put Computer venv ahead of system Python.
export VIRTUAL_ENV="${VENV}"
export PATH="${VENV}/bin:\${PATH}"
export PIP_INDEX_URL="${pip_index}"
export PIP_TRUSTED_HOST="${pip_host}"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
EOF
  chmod 644 /etc/profile.d/coforge-venv.sh

  # pip wrappers are safe: they are not the venv base interpreter.
  if [[ -x "${VENV}/bin/pip" ]]; then
    cat > /usr/local/bin/pip <<EOF
#!/bin/sh
exec "${VENV}/bin/pip" "\$@"
EOF
    cat > /usr/local/bin/pip3 <<EOF
#!/bin/sh
exec "${VENV}/bin/pip3" "\$@"
EOF
    chmod 755 /usr/local/bin/pip /usr/local/bin/pip3
  fi

  # Remove any previous looping python wrappers from older builds and restore
  # the image's /usr/local/bin/python3 → python3.12 style link when needed.
  if [[ -f /usr/local/bin/python3 ]] && head -1 /usr/local/bin/python3 2>/dev/null | grep -q '^#!/bin/sh'; then
    if grep -q "${VENV}/bin/python" /usr/local/bin/python3 2>/dev/null; then
      rm -f /usr/local/bin/python3
      if [[ -x /usr/bin/python3.12 ]]; then
        ln -sfn /usr/bin/python3.12 /usr/local/bin/python3
      else
        ln -sfn /usr/bin/python3 /usr/local/bin/python3
      fi
      log "removed looping /usr/local/bin/python3 wrapper"
    fi
  fi
  if [[ -f /usr/local/bin/python ]] && head -1 /usr/local/bin/python 2>/dev/null | grep -q '^#!/bin/sh'; then
    if grep -q "${VENV}/bin/python" /usr/local/bin/python 2>/dev/null; then
      rm -f /usr/local/bin/python
      ln -sfn python3 /usr/local/bin/python
      log "removed looping /usr/local/bin/python wrapper"
    fi
  fi
}
activate_venv_env() {
  # For callers that source this script's side effects via entrypoint exports.
  if [[ -x "${VENV}/bin/python" ]]; then
    export VIRTUAL_ENV="${VENV}"
    case ":${PATH}:" in
      *":${VENV}/bin:"*) ;;
      *) export PATH="${VENV}/bin:${PATH}" ;;
    esac
  fi
}

restore_opt_launchers() {
  if [[ -x /opt/wechat/wechat ]]; then
    ln -sfn /opt/wechat/wechat /usr/bin/wechat
  fi
  local devtools="/opt/apps/io.github.msojocs.wechat-devtools-linux/files/bin/bin/wechat-devtools"
  if [[ -x "${devtools}" && ! -e /usr/local/bin/wechat-devtools-open.sh ]]; then
    cat > /usr/local/bin/wechat-devtools-open.sh <<EOF
#!/bin/bash
if [[ \$# -eq 0 && -d /root/projects/wechatapp ]]; then
  exec "${devtools}" /root/projects/wechatapp
fi
exec "${devtools}" "\$@"
EOF
    chmod 755 /usr/local/bin/wechat-devtools-open.sh
    log "restored /usr/local/bin/wechat-devtools-open.sh"
  fi
}

copy_opt_desktops() {
  local apps_dir="/root/.local/share/applications"
  mkdir -p "${apps_dir}"
  [[ -d /usr/share/applications ]] || return 0
  shopt -s nullglob
  for desktop in /usr/share/applications/*.desktop; do
    [[ -f "${desktop}" ]] || continue
    if grep -Eq '^Exec=.*/opt/' "${desktop}"; then
      dest="${apps_dir}/$(basename "${desktop}")"
      if [[ ! -e "${dest}" ]]; then
        cp -a "${desktop}" "${dest}"
        log "copied $(basename "${desktop}") -> ${apps_dir}"
      fi
    fi
  done
  shopt -u nullglob
}

persist_opt() {
  if opt_is_volume; then
    mkdir -p /opt
    if [[ -d "${APPS}" ]]; then
      shopt -s nullglob
      for entry in "${APPS}"/*; do
        [[ -e "${entry}" || -L "${entry}" ]] || continue
        local name dest
        name="$(basename "${entry}")"
        dest="/opt/${name}"
        if [[ ! -e "${dest}" && ! -L "${dest}" ]]; then
          cp -a "${entry}" "${dest}"
          log "seeded ${dest} from ${APPS}"
        fi
      done
      shopt -u nullglob
    fi
    restore_opt_launchers
    return 0
  fi
  [[ -d /opt ]] || return 0
  shopt -s nullglob
  # After an image replace /opt is empty; put store trees back first.
  for store in "${APPS}"/*; do
    [[ -e "${store}" || -L "${store}" ]] || continue
    persist_one "/opt/$(basename "${store}")" "${store}"
  done
  for entry in /opt/*; do
    [[ -e "${entry}" || -L "${entry}" ]] || continue
    persist_one "${entry}" "${APPS}/$(basename "${entry}")"
  done
  shopt -u nullglob
  copy_opt_desktops
  restore_opt_launchers
}

write_env_file() {
  # Supervised children / agent tools can source this if their PATH is clean.
  local env_file="${VOLUME}/runtime.env"
  if [[ -x "${VENV}/bin/python" ]]; then
    cat > "${env_file}" <<EOF
VIRTUAL_ENV=${VENV}
PATH=${VENV}/bin:\${PATH}
EOF
  fi
}

if [[ ! -d "${VOLUME}" ]]; then
  log "skip: ${VOLUME} is missing"
  exit 0
fi

mkdir -p "${APPS}" "${HOME_STORE}" "${WORKSPACE_STORE}"

if [[ "${1:-}" == "--watch" ]]; then
  while true; do
    persist_opt || true
    sleep 3
  done
fi

persist_home
persist_workspace
persist_opt
ensure_venv
write_env_file
activate_venv_env
