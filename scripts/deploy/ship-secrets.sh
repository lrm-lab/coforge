#!/usr/bin/env bash
# Ships GitHub Environment values to the deploy host's secrets directory. Each name is read from
# the environment, never from argv, written to a mode-0600 file in a private temporary directory,
# and sent as one tar over ssh; the host unpacks it beside the directory and moves the files in.
#
#   ship-secrets.sh --environment staging --secrets-dir /home/deploy/coforge-staging/infra/staging/secrets \
#     --required "AUTHING_APP_ID OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=otel_traces_endpoint" \
#     --optional "COFORGE_GITHUB_APP_SLUG"
#
# A name is an environment variable; the host file is its lowercase name unless written NAME=file.
# A required name must be non-empty, an optional one is shipped even when empty. The ssh identity
# comes from SSH_DIR, DEPLOY_SSH_USER and DEPLOY_SSH_HOST.
set -euo pipefail

environment=
secrets_dir=
required=
optional=

while [ "$#" -gt 0 ]; do
	case "$1" in
	--environment) environment="${2:?}" ;;
	--secrets-dir) secrets_dir="${2:?}" ;;
	--required) required="${2:?}" ;;
	--optional) optional="${2:?}" ;;
	*)
		printf 'usage: %s --environment NAME --secrets-dir DIR [--required "NAMES"] [--optional "NAMES"]\n' "$0" >&2
		exit 2
		;;
	esac
	shift 2
done
[ -n "$environment" ] && [ -n "$secrets_dir" ] || {
	printf 'ship-secrets: --environment and --secrets-dir are required\n' >&2
	exit 2
}

for entry in $required; do
	name="${entry%%=*}"
	if [ -z "${!name:-}" ]; then
		printf '%s is missing from the %s GitHub Environment\n' "$name" "$environment" >&2
		exit 1
	fi
done

umask 077
tar_dir="$(mktemp -d)"
payload="$(mktemp)"
trap 'rm -rf -- "$tar_dir" "$payload"' EXIT

files=()
for entry in $required $optional; do
	name="${entry%%=*}"
	file="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
	[ "$entry" = "$name" ] || file="${entry#*=}"
	printf '%s' "${!name:-}" >"$tar_dir/$file"
	files+=("$file")
done
tar -czf "$payload" -C "$tar_dir" .

ssh -i "$SSH_DIR/key" \
	-o UserKnownHostsFile="$SSH_DIR/known_hosts" \
	-o BatchMode=yes \
	-o ServerAliveInterval=15 \
	-o ServerAliveCountMax=8 \
	"$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST" \
	"set -eu; \
	 secrets_dir='$secrets_dir'; \
	 mkdir -p \"\$(dirname \"\$secrets_dir\")\"; \
	 incoming=\$(mktemp -d \"\${secrets_dir}.incoming.XXXXXX\"); \
	 trap 'rm -rf -- \"\$incoming\"' EXIT; \
	 tar -xzf - -C \"\$incoming\"; \
	 mkdir -p \"\$secrets_dir\"; \
	 chmod 700 \"\$secrets_dir\"; \
	 for name in ${files[*]}; do \
	   chmod 600 \"\$incoming/\$name\"; \
	   mv -f \"\$incoming/\$name\" \"\$secrets_dir/\$name\"; \
	 done" \
	<"$payload"
