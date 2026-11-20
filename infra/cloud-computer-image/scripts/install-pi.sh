#!/usr/bin/env bash
# Install Pi coding agent + suite during the Swarm computer image build.
# Env: INSTALL_PI, NPM_REGISTRY, PI_SUITE, PI_SUITE_VERSION.
set -euo pipefail

if [[ "${INSTALL_PI:-1}" != "1" ]]; then
  echo "Skipping Pi install (INSTALL_PI=${INSTALL_PI:-})"
  exit 0
fi

npm config set prefix /root/.npm-global
npm config set fetch-retries 5
npm config set fetch-retry-mintimeout 20000
npm config set fetch-retry-maxtimeout 120000
npm config set fetch-timeout 300000
npm config set maxsockets 3

if [[ -n "${NPM_REGISTRY:-}" ]]; then
  npm config set registry "${NPM_REGISTRY}"
  echo "Using npm registry: ${NPM_REGISTRY}"
fi

attempt=1
while true; do
  if npm install -g --ignore-scripts @earendil-works/pi-coding-agent; then
    break
  fi
  if [[ "${attempt}" -ge 5 ]]; then
    echo "npm install @earendil-works/pi-coding-agent failed after ${attempt} attempts" >&2
    exit 1
  fi
  echo "npm install failed (attempt ${attempt}/5); retrying in 15s..." >&2
  attempt=$((attempt + 1))
  sleep 15
done

mkdir -p /root/.pi/agent
PI_SUITE_SOURCE="${PI_SUITE:-npm:@lebronj/pi-suite}"
if [[ "${PI_SUITE_SOURCE}" == "npm:@lebronj/pi-suite" && -n "${PI_SUITE_VERSION:-}" ]]; then
  PI_SUITE_SOURCE="npm:@lebronj/pi-suite@${PI_SUITE_VERSION}"
fi
pi install "${PI_SUITE_SOURCE}"
