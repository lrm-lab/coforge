#!/usr/bin/env bash
# Install redis-server without starting the system service on port 6379, which
# would conflict with the Redis service container in web-integration; tests
# spawn their own isolated redis-server instances on private Unix sockets.
set -euo pipefail

printf '#!/bin/sh\nexit 101\n' | sudo tee /usr/sbin/policy-rc.d >/dev/null
sudo chmod +x /usr/sbin/policy-rc.d
cleanup() {
  sudo rm -f /usr/sbin/policy-rc.d
}
trap cleanup EXIT

scripts/ci/retry.sh 5 10 -- sudo apt-get update
scripts/ci/retry.sh 5 10 -- sudo apt-get install --yes --no-install-recommends redis-server
