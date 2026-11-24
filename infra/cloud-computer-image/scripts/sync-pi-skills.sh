#!/usr/bin/env bash
# Sync Pi agent skills from the persistent workspace into the runtime agent dir.
#
# Source of truth: $WORKSPACE/skills/<name>/ (default /workspace/skills)
# Runtime target:  $PI_AGENT_DIR/skills/     (default /root/.pi/agent/skills)
# Image fallback:  $PI_SKILLS_TEMPLATE       (default /usr/local/share/coforge/pi-skills)
#
# Copies real trees (no skill-root symlinks). Idempotent; safe under flock.
set -euo pipefail

log() { echo "[sync-pi-skills] $*"; }

WORKSPACE="${WORKSPACE:-/workspace}"
WORKSPACE_SKILLS="${PI_WORKSPACE_SKILLS:-${WORKSPACE}/skills}"
PI_HOME="${PI_HOME:-/root}"
AGENT_DIR="${PI_AGENT_DIR:-${PI_HOME}/.pi/agent}"
AGENT_SKILLS="${PI_AGENT_SKILLS:-${AGENT_DIR}/skills}"
TEMPLATE="${PI_SKILLS_TEMPLATE:-/usr/local/share/coforge/pi-skills}"
BAK_ROOT="${PI_SKILLS_BAK_ROOT:-${WORKSPACE_SKILLS}/.bak}"
LOCK_FILE="${PI_SKILLS_SYNC_LOCK:-${WORKSPACE_SKILLS}/.sync.lock}"
# Names last known to live under workspace. Used so a workspace delete is not
# "promoted" back from a leftover agent copy on the next sync.
ORIGIN_MANIFEST="${PI_SKILLS_ORIGIN_MANIFEST:-${WORKSPACE_SKILLS}/.workspace-origin}"

from_image=0
from_workspace=0
conflicts=0
promoted=0
removed=0
skipped=0

declare -A PREV_WORKSPACE_ORIGIN=()
declare -A NEXT_WORKSPACE_ORIGIN=()

load_origin_manifest() {
  PREV_WORKSPACE_ORIGIN=()
  [[ -f "${ORIGIN_MANIFEST}" ]] || return 0
  local name
  while IFS= read -r name || [[ -n "${name}" ]]; do
    [[ -n "${name}" ]] || continue
    [[ "${name}" == \#* ]] && continue
    PREV_WORKSPACE_ORIGIN["${name}"]=1
  done <"${ORIGIN_MANIFEST}"
}

write_origin_manifest() {
  local name
  mkdir -p "$(dirname "${ORIGIN_MANIFEST}")"
  {
    echo "# managed by sync-pi-skills.sh — do not edit"
    for name in $(printf '%s\n' "${!NEXT_WORKSPACE_ORIGIN[@]}" | LC_ALL=C sort); do
      printf '%s\n' "${name}"
    done
  } >"${ORIGIN_MANIFEST}.tmp.$$"
  mv "${ORIGIN_MANIFEST}.tmp.$$" "${ORIGIN_MANIFEST}"
}

is_skill_dir() {
  local path="$1"
  [[ -d "${path}" || -L "${path}" ]] || return 1
  local base
  base="$(basename "${path}")"
  [[ "${base}" != .* && "${base}" != *.tmp && "${base}" != *.tmp.* ]] || return 1
  [[ -f "${path}/SKILL.md" ]] || return 1
  return 0
}

# Content fingerprint of a skill tree. Symlinks are hashed by target path so
# softlink workarounds do not look identical to a real copy.
skill_hash() {
  local dir="$1"
  if [[ ! -e "${dir}" ]]; then
    printf 'missing\n'
    return 0
  fi
  if [[ -L "${dir}" ]]; then
    printf 'symlink:%s\n' "$(readlink -n "${dir}" 2>/dev/null || true)"
    return 0
  fi
  # Portable: sorted path + sha256 of file contents (or link target).
  (
    cd "${dir}" || exit 0
    find . -mindepth 1 \( -type f -o -type l \) -print 2>/dev/null \
      | LC_ALL=C sort \
      | while IFS= read -r rel; do
          if [[ -L "${rel}" ]]; then
            printf 'L %s -> %s\n' "${rel}" "$(readlink -n "${rel}" 2>/dev/null || true)"
          else
            # Hash file; fall back to size if sha256sum unavailable.
            if command -v sha256sum >/dev/null 2>&1; then
              sha256sum "${rel}" 2>/dev/null || printf 'ERR %s\n' "${rel}"
            else
              wc -c <"${rel}" 2>/dev/null | awk -v p="${rel}" '{print $1 " " p}'
            fi
          fi
        done
  ) | if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | awk '{print $1}'
      else
        cksum | awk '{print $1}'
      fi
}

backup_skill() {
  local src="$1"
  local name="$2"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%Y%m%d%H%M%S)"
  mkdir -p "${BAK_ROOT}"
  local dest="${BAK_ROOT}/${name}-${ts}"
  local n=0
  while [[ -e "${dest}" ]]; do
    n=$((n + 1))
    dest="${BAK_ROOT}/${name}-${ts}-${n}"
  done
  cp -a "${src}" "${dest}"
  log "backed up ${name} -> ${dest}"
}

# Atomic replace of dest with a copy of src (dereferences skill-root symlink).
install_skill_copy() {
  local src="$1"
  local dest="$2"
  local parent tmp
  parent="$(dirname "${dest}")"
  mkdir -p "${parent}"
  tmp="${dest}.tmp.$$"
  rm -rf "${tmp}"
  # -a preserves mode/times; if src is a symlink root, copy the target tree.
  if [[ -L "${src}" ]]; then
    local target
    target="$(readlink -f "${src}" 2>/dev/null || true)"
    if [[ -n "${target}" && -d "${target}" ]]; then
      cp -a "${target}" "${tmp}"
    else
      log "WARN: broken symlink skill src ${src}; skip"
      return 1
    fi
  else
    cp -a "${src}" "${tmp}"
  fi
  # Drop nested skill-root softlinks that would confuse strict scanners.
  if [[ -L "${dest}" ]]; then
    rm -f "${dest}"
  elif [[ -e "${dest}" ]]; then
    rm -rf "${dest}.old.$$"
    mv "${dest}" "${dest}.old.$$"
  fi
  mv "${tmp}" "${dest}"
  rm -rf "${dest}.old.$$" 2>/dev/null || true
}

list_skill_names() {
  local root="$1"
  [[ -d "${root}" ]] || return 0
  local path base
  shopt -s nullglob
  for path in "${root}"/*; do
    base="$(basename "${path}")"
    [[ "${base}" == .* ]] && continue
    is_skill_dir "${path}" || continue
    printf '%s\n' "${base}"
  done
  shopt -u nullglob
}

promote_agent_customs() {
  local name agent_path
  [[ -d "${AGENT_SKILLS}" ]] || return 0
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    agent_path="${AGENT_SKILLS}/${name}"
    # Skip softlink roots left by the old workaround; workspace owns those.
    if [[ -L "${agent_path}" ]]; then
      continue
    fi
    if [[ -d "${WORKSPACE_SKILLS}/${name}" ]]; then
      continue
    fi
    # Previously synced from workspace but missing there now → user deleted it.
    if [[ -n "${PREV_WORKSPACE_ORIGIN[${name}]:-}" ]]; then
      continue
    fi
    if [[ -d "${TEMPLATE}/${name}" ]] && [[ "$(skill_hash "${agent_path}")" == "$(skill_hash "${TEMPLATE}/${name}")" ]]; then
      continue
    fi
    mkdir -p "${WORKSPACE_SKILLS}"
    install_skill_copy "${agent_path}" "${WORKSPACE_SKILLS}/${name}"
    NEXT_WORKSPACE_ORIGIN["${name}"]=1
    promoted=$((promoted + 1))
    log "promoted agent skill ${name} -> ${WORKSPACE_SKILLS}/${name}"
  done < <(list_skill_names "${AGENT_SKILLS}")
}

sync_from_workspace() {
  local name src dest
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    src="${WORKSPACE_SKILLS}/${name}"
    dest="${AGENT_SKILLS}/${name}"
    if [[ -e "${dest}" || -L "${dest}" ]] && [[ "$(skill_hash "${src}")" == "$(skill_hash "${dest}")" ]] && [[ ! -L "${dest}" ]]; then
      skipped=$((skipped + 1))
      from_workspace=$((from_workspace + 1))
      continue
    fi
    if [[ -L "${dest}" ]]; then
      # Replace legacy softlink workaround with a real tree; no conflict backup.
      rm -f "${dest}"
    elif [[ -d "${dest}" ]]; then
      # Workspace wins; keep a backup of the runtime copy we replace.
      backup_skill "${dest}" "${name}" || true
      if [[ -d "${TEMPLATE}/${name}" ]]; then
        conflicts=$((conflicts + 1))
      fi
    fi
    install_skill_copy "${src}" "${dest}"
    NEXT_WORKSPACE_ORIGIN["${name}"]=1
    from_workspace=$((from_workspace + 1))
  done < <(list_skill_names "${WORKSPACE_SKILLS}")
}

mark_workspace_origins() {
  local name
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    NEXT_WORKSPACE_ORIGIN["${name}"]=1
  done < <(list_skill_names "${WORKSPACE_SKILLS}")
}

seed_image_into_workspace() {
  local name src dest
  [[ -d "${TEMPLATE}" ]] || return 0
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    # Never overwrite a user/workspace skill with the image copy.
    if [[ -d "${WORKSPACE_SKILLS}/${name}" ]]; then
      continue
    fi
    src="${TEMPLATE}/${name}"
    dest="${WORKSPACE_SKILLS}/${name}"
    install_skill_copy "${src}" "${dest}"
    NEXT_WORKSPACE_ORIGIN["${name}"]=1
    from_image=$((from_image + 1))
    log "seeded image skill ${name} -> ${WORKSPACE_SKILLS}/${name}"
  done < <(list_skill_names "${TEMPLATE}")
}

cleanup_stale_agent_skills() {
  local name dest
  [[ -d "${AGENT_SKILLS}" ]] || return 0
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    dest="${AGENT_SKILLS}/${name}"
    if [[ -d "${WORKSPACE_SKILLS}/${name}" ]]; then
      continue
    fi
    if [[ -d "${TEMPLATE}/${name}" ]]; then
      continue
    fi
    # Leftover from a deleted workspace skill (or old softlink).
    rm -rf "${dest}"
    removed=$((removed + 1))
    log "removed stale agent skill ${name}"
  done < <(list_skill_names "${AGENT_SKILLS}")
}

main() {
  mkdir -p "${WORKSPACE_SKILLS}" "${AGENT_SKILLS}" "${BAK_ROOT}"
  mkdir -p "$(dirname "${LOCK_FILE}")"

  # Lock across agents sharing this Computer / workspace.
  exec 9>"${LOCK_FILE}"
  if ! flock -w 120 9; then
    log "WARN: could not acquire lock ${LOCK_FILE}; proceeding unlocked"
  fi

  # Drop leftover half-written temps from a killed sync.
  shopt -s nullglob
  for tmp in "${AGENT_SKILLS}"/*.tmp "${AGENT_SKILLS}"/*.tmp.*; do
    [[ -e "${tmp}" ]] || continue
    rm -rf "${tmp}"
  done
  shopt -u nullglob

  load_origin_manifest
  promote_agent_customs
  # Seed official image skills into the persistent workspace (never overwrite user).
  seed_image_into_workspace
  # Materialize workspace → runtime agent dir (bind-pi-skills may then overlay).
  sync_from_workspace
  mark_workspace_origins
  cleanup_stale_agent_skills
  write_origin_manifest

  log "skills: ${from_image} from image, ${from_workspace} from workspace, ${conflicts} conflicts resolved (promoted=${promoted} removed=${removed} skipped=${skipped})"
}

main "$@"
