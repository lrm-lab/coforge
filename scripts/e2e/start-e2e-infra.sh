#!/usr/bin/env bash
set -euo pipefail

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH='' cd -- "$here/../.." && pwd)
secrets="$root/infra/secrets"
mkdir -p "$secrets"
for name in redis_password centrifugo_http_api_key centrifugo_proxy_secret postgres_password; do
  if [[ ! -s "$secrets/$name" ]]; then
    openssl rand -hex 32 >"$secrets/$name"
    chmod 600 "$secrets/$name"
  fi
done

docker compose -p coforge-e2e -f "$root/infra/docker-compose.yml" up --detach --wait --remove-orphans
