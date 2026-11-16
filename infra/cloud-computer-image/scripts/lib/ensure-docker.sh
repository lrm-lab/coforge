#!/usr/bin/env bash
# Ensure `docker` works in Cursor / long-lived SSH sessions that miss the
# docker supplementary group. Prefers ~/.local/bin/docker (sg docker wrapper).

ensure_docker() {
  # User wrapper first (see ~/.local/bin/docker).
  if [[ -n "${HOME:-}" && -d "${HOME}/.local/bin" ]]; then
    case ":${PATH}:" in
      *":${HOME}/.local/bin:"*) ;;
      *) export PATH="${HOME}/.local/bin:${PATH}" ;;
    esac
  fi

  if [[ -z "${DOCKER_BIN:-}" ]]; then
    if [[ -x "${HOME}/.local/bin/docker" ]]; then
      DOCKER_BIN="${HOME}/.local/bin/docker"
    else
      DOCKER_BIN="$(command -v docker || true)"
    fi
  fi
  export DOCKER_BIN

  if [[ -z "${DOCKER_BIN}" ]]; then
    echo "[ensure-docker] ERROR: docker not found on PATH" >&2
    return 1
  fi

  if ! "${DOCKER_BIN}" version >/dev/null 2>&1; then
    echo "[ensure-docker] ERROR: cannot talk to Docker daemon via ${DOCKER_BIN}" >&2
    echo "[ensure-docker] hint: ensure you are in the docker group, or install ~/.local/bin/docker wrapper" >&2
    return 1
  fi
}
