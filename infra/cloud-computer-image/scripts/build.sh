#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
source ./scripts/lib/ensure-docker.sh
ensure_docker

TAG="${TAG:-coforge-pi:local}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-cube-sandbox-cn.tencentcloudcr.com/cube-sandbox/sandbox-code@sha256:b551b169de85c0216cce9453a8e22059ca47fd3dceced75e918cf1c8de60464b}"
PI_CONFIG="${PI_CONFIG:-config/pi.env}"

EXTRA=(
  --build-arg "SANDBOX_IMAGE=${SANDBOX_IMAGE}"
  --build-arg "NODE_MAJOR=${NODE_MAJOR:-22}"
  --build-arg "APT_MIRROR=${APT_MIRROR:-https://mirrors.cloud.tencent.com/debian}"
  --build-arg "APT_SECURITY_MIRROR=${APT_SECURITY_MIRROR:-https://mirrors.cloud.tencent.com/debian-security}"
  --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"
  --build-arg "PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST:-mirrors.aliyun.com}"
)
mkdir -p coforge
# Release feed is on coforge.cn; a local clash/v2ray proxy often resets that TLS
# session. Always fetch the feed direct (mirrors still use DOCKER_BUILD_NETWORK).
curl_feed() {
  env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
      -u http_proxy -u https_proxy -u all_proxy -u no_proxy \
      curl "$@"
}
if [[ -n "${COFORGE_RELEASE_FEED_URL:-}" ]]; then
  feed="${COFORGE_RELEASE_FEED_URL%/}"
  cloud_host="${COFORGE_CLOUD_HOST:-}"
  staged_bin="coforge/coforge-computer"
  version="$(curl_feed -fsSL --retry 3 --retry-all-errors "${feed}/latest" | tr -d '[:space:]')"
  case "${version}" in
    ""|latest|.|*..*|-*)
      echo "[build.sh] ERROR: feed latest is not a version: ${version}" >&2
      exit 1
      ;;
  esac
  if ! printf '%s' "${version}" | grep -Eq '^[A-Za-z0-9.+-]{1,100}$'; then
    echo "[build.sh] ERROR: feed latest is not a version: ${version}" >&2
    exit 1
  fi
  expected="$(curl_feed -fsSL --retry 3 --retry-all-errors "${feed}/${version}/linux-x64/coforge-computer.sha256" | tr -d '[:space:]')"
  if [[ ! "${expected}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "[build.sh] ERROR: feed sha256 for ${version} is not a checksum" >&2
    exit 1
  fi

  reuse=0
  if [[ "${COFORGE_COMPUTER_FORCE_DOWNLOAD:-}" != "1" && -x "${staged_bin}" ]]; then
    actual="$(sha256sum "${staged_bin}" | awk '{print $1}')"
    if [[ "${actual}" == "${expected}" ]]; then
      reuse=1
      echo "[build.sh] reusing cached ${staged_bin} (${version}; sha256 matches feed)"
    else
      echo "[build.sh] cached ${staged_bin} sha256 differs from feed ${version}; re-downloading"
    fi
  fi

  if [[ "${reuse}" -eq 0 ]]; then
    tmp="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '${tmp}'" EXIT
    echo "[build.sh] downloading ${feed}/${version}/linux-x64/coforge-computer.gz"
    # -s hides the meter; keep -fL and show a progress bar for the large binary.
    curl_feed -fL --retry 3 --retry-all-errors --progress-bar "${feed}/${version}/linux-x64/coforge-computer.gz" -o "${tmp}/coforge-computer.gz"
    gzip -dc "${tmp}/coforge-computer.gz" > "${staged_bin}"
    actual="$(sha256sum "${staged_bin}" | awk '{print $1}')"
    if [[ "${actual}" != "${expected}" ]]; then
      echo "[build.sh] ERROR: Computer checksum mismatch" >&2
      exit 1
    fi
    rm -rf "${tmp}"
    trap - EXIT
  fi

  if [[ -n "${cloud_host}" ]]; then
    if ! grep -a -q "${cloud_host}" "${staged_bin}"; then
      echo "[build.sh] ERROR: Computer is not baked for ${cloud_host}" >&2
      exit 1
    fi
  else
    echo "[build.sh] WARN: COFORGE_CLOUD_HOST unset; skipping cloud-host bake check" >&2
  fi
  if ! grep -a -q 'COFORGE_CLUSTER_TOKEN' "${staged_bin}"; then
    echo "[build.sh] ERROR: Computer has no cloud host; publish the post-merge build first" >&2
    exit 1
  fi
  chmod 755 "${staged_bin}"
  EXTRA+=(
    --build-arg "COMPUTER_VERSION=${version}"
    --build-arg "COFORGE_RELEASE_FEED_URL=${feed}"
    --build-arg "COFORGE_ENVIRONMENT=${COFORGE_ENVIRONMENT:-}"
    --build-arg "COFORGE_CLOUD_HOST=${cloud_host}"
  )
  if [[ "${reuse}" -eq 1 ]]; then
    echo "[build.sh] staged CoForge Computer ${version} from cache (env=${COFORGE_ENVIRONMENT:-unknown})"
  else
    echo "[build.sh] staged CoForge Computer ${version} from ${feed} (env=${COFORGE_ENVIRONMENT:-unknown})"
  fi
else
  COFORGE_COMPUTER_BIN="${COFORGE_COMPUTER_BIN:-${HOME}/.coforge/computer/install/active/coforge-computer}"
  if [[ ! -x "${COFORGE_COMPUTER_BIN}" ]]; then
    echo "[build.sh] ERROR: missing CoForge Computer binary: ${COFORGE_COMPUTER_BIN}" >&2
    exit 1
  fi
  cp "${COFORGE_COMPUTER_BIN}" coforge/coforge-computer
  chmod 755 coforge/coforge-computer
  echo "[build.sh] staged CoForge Computer from ${COFORGE_COMPUTER_BIN}"
fi

if [[ -f "${PI_CONFIG}" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "${PI_CONFIG}"
  set +a
  echo "[build.sh] loaded Pi build config from ${PI_CONFIG}"
fi

INSTALL_PI="${INSTALL_PI:-1}"
EXTRA+=(--build-arg "INSTALL_PI=${INSTALL_PI}")

if [[ "${INSTALL_PI}" == "1" ]]; then
  if [[ -z "${LENOVO_DEEPSEEK_V4_FLASH_API_KEY:-}" ]]; then
    echo "[build.sh] ERROR: LENOVO_DEEPSEEK_V4_FLASH_API_KEY is required in ${PI_CONFIG} (baked into image)" >&2
    exit 1
  fi
  EXTRA+=(
    --build-arg "PI_SUITE_VERSION=${PI_SUITE_VERSION:-0.1.17}"
    --build-arg "PI_SUITE=${PI_SUITE:-npm:@lebronj/pi-suite}"
    --build-arg "PI_WORKSPACE_DIR=${PI_WORKSPACE_DIR:-/workspace}"
    --build-arg "PI_EVOLUTION_ENABLED=${PI_EVOLUTION_ENABLED:-1}"
    --build-arg "LENOVO_DEEPSEEK_V4_FLASH_API_KEY=${LENOVO_DEEPSEEK_V4_FLASH_API_KEY}"
    --build-arg "LENOVO_DEEPSEEK_PROVIDER=${LENOVO_DEEPSEEK_PROVIDER:-modelfactoryllm}"
    --build-arg "LENOVO_DEEPSEEK_MODEL=${LENOVO_DEEPSEEK_MODEL:-DeepSeek}"
    --build-arg "LENOVO_DEEPSEEK_BASE_URL=${LENOVO_DEEPSEEK_BASE_URL:-https://modelfactory.lenovo.com/llm/v1}"
    --build-arg "LENOVO_DEEPSEEK_MODEL_NAME=${LENOVO_DEEPSEEK_MODEL_NAME:-DeepSeek}"
    --build-arg "LENOVO_DEEPSEEK_AS_DEFAULT=${LENOVO_DEEPSEEK_AS_DEFAULT:-1}"
  )
  [[ -n "${NPM_REGISTRY:-}" ]] && EXTRA+=(--build-arg "NPM_REGISTRY=${NPM_REGISTRY}")
  echo "[build.sh] Pi install: enabled (suite ${PI_SUITE_VERSION:-0.1.17}); modelfactoryllm(DeepSeek+) will be baked into the image"
else
  echo "[build.sh] Pi install: skipped (INSTALL_PI=0)"
fi

echo "[build.sh] SANDBOX_IMAGE=${SANDBOX_IMAGE}"
echo "[build.sh] APT_MIRROR=${APT_MIRROR:-https://mirrors.cloud.tencent.com/debian}"
echo "[build.sh] PIP_INDEX_URL=${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"
echo "[build.sh] tag=${TAG}"
# Default: strip host proxy (127.0.0.1 is the build container, not the host) and
# let apt/pip/npm hit the China mirrors directly. Set DOCKER_BUILD_NETWORK=host
# when those mirrors time out and the host proxy must be reachable as 127.0.0.1.
DOCKER_BUILD_NETWORK="${DOCKER_BUILD_NETWORK:-}"
if [[ -n "${DOCKER_BUILD_NETWORK}" ]]; then
  EXTRA+=(--network "${DOCKER_BUILD_NETWORK}")
  echo "[build.sh] docker network=${DOCKER_BUILD_NETWORK} (proxy env kept)"
  "${DOCKER_BIN}" build "${EXTRA[@]}" -t "${TAG}" .
else
  env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
      -u http_proxy -u https_proxy -u all_proxy -u no_proxy \
      "${DOCKER_BIN}" build "${EXTRA[@]}" -t "${TAG}" .
fi
