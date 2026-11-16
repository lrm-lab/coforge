#!/usr/bin/env bash
# Build the Swarm computer image for the configured CoForge environment.
# Defaults come from config/coforge.env + config/environments/<env>.env.
# Dual LLM (Brazil muse-spark + Beijing DeepSeek) is baked from config/pi.env.
# The image tag is what the host's
# COFORGE_COMPUTER_IMAGE expects.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
source ./scripts/lib/coforge-env.sh
coforge_load_env

if [[ -z "${COFORGE_RELEASE_FEED_URL:-}" ]]; then
  echo "[build-swarm.sh] ERROR: COFORGE_RELEASE_FEED_URL is empty after loading env" >&2
  exit 1
fi
if [[ -z "${TAG:-}" ]]; then
  echo "[build-swarm.sh] ERROR: TAG / COFORGE_IMAGE_TAG is empty after loading env" >&2
  exit 1
fi

export COFORGE_RELEASE_FEED_URL
export COFORGE_CLOUD_HOST="${COFORGE_CLOUD_HOST:-}"
export COFORGE_ENVIRONMENT
export TAG
exec ./scripts/build.sh
