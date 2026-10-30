#!/usr/bin/env bash
# Prints the catalog snapshot of one environment's database as JSON on stdout: table names,
# estimated row counts and sizes from pg_class, nothing else (scripts/migration-safety/snapshot.ts).
#
# It runs on the deploy host, in the `migrate` container of the release that is deployed (the .env
# the last deploy wrote names its image and DATABASE_URL), so the database needs no new access and
# nothing is installed on the host. The catalog-snapshot workflow ships this file and
# deploy-secrets.sh next to the Compose assets and runs it over ssh.
#
# Usage:
#   catalog-snapshot.sh --environment staging --compose-file ~/coforge-staging/infra/staging/docker-compose.yml \
#     --secrets-dir ~/coforge-staging/infra/staging/secrets [--project coforge-staging]
set -euo pipefail

# shellcheck source=deploy-secrets.sh
source "$(dirname "${BASH_SOURCE[0]}")/deploy-secrets.sh"

usage() {
	printf 'usage: %s --environment NAME --compose-file FILE --secrets-dir DIR [--project NAME]\n' "$0" >&2
	exit 2
}

environment=
compose_file=
secrets_dir=
project=

while [ "$#" -gt 0 ]; do
	case "$1" in
	--environment) environment="${2:?}" ;;
	--compose-file) compose_file="${2:?}" ;;
	--secrets-dir) secrets_dir="${2:?}" ;;
	--project) project="${2:?}" ;;
	*) usage ;;
	esac
	shift 2
done

[ -n "$environment" ] || usage
[ -n "$compose_file" ] || usage
[ -n "$secrets_dir" ] || usage
project="${project:-coforge-$environment}"

COMPOSE_ARGS=(-p "$project" -f "$compose_file")
readonly COMPOSE_ARGS

if [ ! -f "$(dirname "$compose_file")/.env" ]; then
	printf 'catalog-snapshot: no deploy .env beside %s; nothing has been deployed here yet\n' "$compose_file" >&2
	exit 1
fi

load_compose_secrets

# shellcheck disable=SC2016 # single-quoted on purpose: "$1" expands in the container's shell.
# Progress and pull messages stay on stderr; stdout is the snapshot alone.
compose run --rm --no-deps --entrypoint sh migrate \
	-c 'cd .migrate && bun migration-safety/catalog-snapshot.ts "$1"' sh "$environment" </dev/null
