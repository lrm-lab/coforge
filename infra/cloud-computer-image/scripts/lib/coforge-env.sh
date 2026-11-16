#!/usr/bin/env bash
# Load CoForge environment presets for build / activate scripts.
# Priority (high → low): already-exported vars → config/coforge.env →
# config/environments/<COFORGE_ENV>.env → built-in staging fallback.

coforge_repo_root() {
  if [[ -n "${COFORGE_REPO_ROOT:-}" ]]; then
    printf '%s\n' "${COFORGE_REPO_ROOT}"
    return 0
  fi
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  printf '%s\n' "${here}"
}

# Apply KEY=VALUE lines only when the key is currently unset/empty.
coforge_source_defaults() {
  local file="$1"
  local line key value
  [[ -f "${file}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" ]] && continue
    [[ "${line}" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#"${key%%[![:space:]]*}"}"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ -z "${!key:-}" ]]; then
      export "${key}=${value}"
    fi
  done < "${file}"
}

coforge_load_env() {
  local root env_name preset_file active_file
  local -A preserved=()
  local key

  root="$(coforge_repo_root)"
  active_file="${COFORGE_ENV_FILE:-${root}/config/coforge.env}"

  for key in \
    COFORGE_ENV \
    COFORGE_ENVIRONMENT \
    COFORGE_RELEASE_FEED_URL \
    COFORGE_CLOUD_HOST \
    COFORGE_IMAGE_TAG \
    TAG
  do
    if [[ -n "${!key:-}" ]]; then
      preserved["${key}"]="${!key}"
    fi
  done

  # Active file may set COFORGE_ENV and optional field overrides.
  coforge_source_defaults "${active_file}"

  env_name="${COFORGE_ENV:-staging}"
  preset_file="${root}/config/environments/${env_name}.env"
  if [[ ! -f "${preset_file}" ]]; then
    echo "[coforge-env] ERROR: unknown COFORGE_ENV=${env_name} (missing ${preset_file})" >&2
    return 1
  fi

  # Preset fills remaining unset keys; active file already applied above.
  # Re-read active file after preset so explicit overrides in coforge.env win
  # over preset defaults (still lose to caller-exported vars restored below).
  coforge_source_defaults "${preset_file}"
  if [[ -f "${active_file}" ]]; then
    # Force active-file keys (except we restore caller exports afterwards).
    local line key value
    while IFS= read -r line || [[ -n "${line}" ]]; do
      line="${line%%#*}"
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [[ -z "${line}" ]] && continue
      [[ "${line}" == *=* ]] || continue
      key="${line%%=*}"
      value="${line#*=}"
      key="${key%"${key##*[![:space:]]}"}"
      key="${key#"${key%%[![:space:]]*}"}"
      [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      [[ "${key}" == "COFORGE_ENV" ]] && continue
      export "${key}=${value}"
    done < "${active_file}"
  fi

  for key in "${!preserved[@]}"; do
    export "${key}=${preserved[${key}]}"
  done

  export COFORGE_ENV="${COFORGE_ENV:-${env_name}}"
  export COFORGE_ENVIRONMENT="${COFORGE_ENVIRONMENT:-${COFORGE_ENV}}"
  if [[ -z "${TAG:-}" && -n "${COFORGE_IMAGE_TAG:-}" ]]; then
    export TAG="${COFORGE_IMAGE_TAG}"
  fi

  echo "[coforge-env] env=${COFORGE_ENVIRONMENT} feed=${COFORGE_RELEASE_FEED_URL:-} cloud=${COFORGE_CLOUD_HOST:-} tag=${TAG:-${COFORGE_IMAGE_TAG:-}}" >&2
}
