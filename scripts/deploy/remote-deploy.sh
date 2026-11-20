#!/usr/bin/env bash
# Deploy one immutable image digest to the coforge-staging Compose project.
#
# This script runs on the target host only. It consumes the release contract
# in docs/release/: one immutable digest per deployment, the previous
# healthy digest recorded before mutation, automatic rollback on health
# failure, and a key=value report on stdout that never contains secret
# values. The rollback unit is the last healthy release, not only the image:
# the exact image digest plus the shipped Compose file, Caddyfile, and
# Centrifugo configuration, snapshotted together once a deployment is verified
# healthy and restored together when a later candidate fails. Runtime Authing and session values stay
# out of the deploy .env file and container environment.
#
# The functions that read the host secret files live in deploy-secrets.sh, the release snapshot
# functions in deploy-release-snapshot.sh, the bounded failure diagnostics in
# deploy-diagnostics.sh and the post-deploy image retention in deploy-image-retention.sh.
# These ship to the host together, and the
# deploy workflows run the host copy: ssh HOST "bash ~/coforge-staging/scripts/deploy/remote-deploy.sh ARGS"
#
# Usage:
#   remote-deploy.sh --image REGISTRY/REPOSITORY@sha256:... \
#     --compose-file ~/coforge-staging/infra/staging/docker-compose.yml \
#     --secrets-dir ~/coforge-staging/infra/staging/secrets \
#     --state-file ~/coforge-staging/state.env \
#     --web-health-url http://127.0.0.1:18080/health \
#     --public-health-url https://staging.coforge.cn/health \
#     [--project coforge-staging] [--timeout 120]
set -euo pipefail

# shellcheck source=deploy-secrets.sh
source "$(dirname "${BASH_SOURCE[0]}")/deploy-secrets.sh"
# shellcheck source=deploy-release-snapshot.sh
source "$(dirname "${BASH_SOURCE[0]}")/deploy-release-snapshot.sh"
# shellcheck source=deploy-diagnostics.sh
source "$(dirname "${BASH_SOURCE[0]}")/deploy-diagnostics.sh"
# shellcheck source=deploy-wildcard-probe.sh
source "$(dirname "${BASH_SOURCE[0]}")/deploy-wildcard-probe.sh"
# shellcheck source=deploy-image-retention.sh
source "$(dirname "${BASH_SOURCE[0]}")/deploy-image-retention.sh"

# Report state the sourced helpers and report() share; under `set -u` it must
# exist before the same-image no-op branch can read it.
deploy_warning=

usage() {
	printf 'usage: %s --image IMAGE --compose-file FILE --secrets-dir DIR --state-file FILE --web-health-url URL --public-health-url URL [--project NAME] [--timeout SECONDS] [--public-health-timeout SECONDS] [--wildcard-probe-host HOST] [--wildcard-probe-timeout SECONDS]\n' "$0" >&2
	exit 2
}

project=coforge-staging
timeout=120
# How long the public HTTPS check keeps trying once the stack is healthy. A first deployment has
# no certificate when Caddy starts: it obtains one after it is up, and until then a TLS handshake
# fails with an internal-error alert, so one attempt reads as a broken release.
public_health_timeout=180
wildcard_probe_timeout=60
wildcard_probe_host=
# Each Web image pull attempt ends at a deadline, then a forced kill. On 2026-10-13 and 2026-10-16
# one layer's connection from the production host to ghcr.io fell to well under 1 Mbps without
# ever failing, and the unbounded pull outlived the 15-minute job. The Engine abandons a pull when
# its client's connection drops (https://docs.docker.com/reference/cli/docker/image/pull/), so the
# next attempt starts on fresh connections. The deadline sits above the slowest healthy pull
# seen: every layer, cold, in 3m06s on 2026-10-12.
web_pull_attempts=3
web_pull_deadline=210
image=
checker_image=
compose_file=
secrets_dir=
state_file=
web_health_url=
public_health_url=

while [ "$#" -gt 0 ]; do
	case "$1" in
	--project)
		project="${2:?}"
		shift 2
		;;
	--timeout)
		timeout="${2:?}"
		shift 2
		;;
	--wildcard-probe-host)
		wildcard_probe_host="${2:?}"
		shift 2
		;;
	--wildcard-probe-timeout)
		wildcard_probe_timeout="${2:?}"
		shift 2
		;;
	--public-health-timeout)
		public_health_timeout="${2:?}"
		shift 2
		;;
	--image)
		image="${2:?}"
		shift 2
		;;
	--checker-image)
		checker_image="${2-}"
		shift 2
		;;
	--compose-file)
		compose_file="${2:?}"
		shift 2
		;;
	--secrets-dir)
		secrets_dir="${2:?}"
		shift 2
		;;
	--state-file)
		state_file="${2:?}"
		shift 2
		;;
	--web-health-url)
		web_health_url="${2:?}"
		shift 2
		;;
	--public-health-url)
		public_health_url="${2:?}"
		shift 2
		;;
	*)
		printf 'unknown flag: %s\n' "$1" >&2
		usage
		;;
	esac
done

[ -n "$image" ] || usage
[ -n "$compose_file" ] || usage
[ -n "$secrets_dir" ] || usage
[ -n "$state_file" ] || usage
[ -n "$web_health_url" ] || usage
[ -n "$public_health_url" ] || usage

checker_compose_file="$(dirname "$compose_file")/../artifact-checker.compose.yml"
if [ -n "$checker_image" ] && [ -f "$checker_compose_file" ]; then
	readonly COMPOSE_ARGS=(-p "$project" -f "$compose_file" -f "$checker_compose_file")
else
	readonly COMPOSE_ARGS=(-p "$project" -f "$compose_file")
fi

# The last healthy release: the shipped Compose file, Caddyfile, and Centrifugo
# configuration that were live the last time this script recorded a healthy
# deployment. The deploy workflow overwrites these paths on the host before
# this script ever runs (see "Copy deployment assets" in deploy-staging.yml),
# so by the time a bad configuration is detected the previous good copy is
# already gone from its live path; this snapshot is the only place it survives.
release_snapshot_dir="$(dirname "$state_file")/last-healthy"
release_snapshot_files=(docker-compose.yml caddy/Caddyfile centrifugo/config.yaml)

# Fail closed on a mutable reference instead of guessing the intended digest.
if ! printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
	printf 'outcome=failed\nhealth_result=mutable image reference rejected\nrollback_target=\nprevious_web_image=\n'
	exit 0
fi
if [ -n "$checker_image" ] && ! printf '%s' "$checker_image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
	printf 'outcome=failed\nhealth_result=mutable checker image reference rejected\nrollback_target=\nprevious_web_image=\n'
	exit 0
fi

load_compose_secrets

read_state_value() {
	grep -E "^$1=" "$state_file" 2>/dev/null | head -n 1 | cut -d= -f2- || true
}

# Reads and validates the release state. A missing state file is only a
# bootstrap when the environment is verifiably empty; otherwise fail closed.
current_image=""
previous_image=""
if [ -f "$state_file" ]; then
	current_image="$(read_state_value CURRENT_WEB_IMAGE)"
	previous_image="$(read_state_value PREVIOUS_WEB_IMAGE)"
	for value in "$current_image" "$previous_image"; do
		if [ -n "$value" ] && ! printf '%s' "$value" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
			printf 'outcome=failed\nhealth_result=failed: release state file holds a non-digest image; refusing to mutate\nrollback_target=\nprevious_web_image=\n'
			exit 0
		fi
	done
else
	if [ -n "$(compose ps -q web 2>/dev/null)" ]; then
		printf 'outcome=failed\nhealth_result=failed: state file missing on a non-empty environment; refusing to guess bootstrap\nrollback_target=\nprevious_web_image=\n'
		exit 0
	fi
fi

# Fail closed on a malformed state file (truncated write, manual edit).
if [ -f "$state_file" ]; then
	for key in CURRENT_WEB_IMAGE PREVIOUS_WEB_IMAGE; do
		if ! grep -qE "^$key=" "$state_file"; then
			printf 'outcome=failed\nhealth_result=failed: release state is malformed; refusing to mutate\nrollback_target=\nprevious_web_image=\n'
			exit 0
		fi
	done
fi

# The rollback target is the last known healthy image, not the one before it.
last_healthy="$current_image"

if [ -n "$current_image" ] && [ "$current_image" = "$image" ]; then
	prune_deploy_images
	printf 'previous_web_image=%s\nhealth_result=healthy\noutcome=healthy\nrollback_target=\n' "$current_image"
	[ -z "$deploy_warning" ] || printf 'warning=%s\n' "$deploy_warning"
	exit 0
fi

compose_all_healthy() {
	local service container services
	services="$(compose config --services)" || return 1
	for service in web centrifugo redis postgres artifact-checker; do
		# Managed datastores (production) have no Compose service to check.
		grep -qx "$service" <<<"$services" || continue
		container="$(compose ps -q "$service")"
		[ -n "$container" ] || return 1
		[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ] || return 1
	done
	return 0
}

wait_for_health() {
	local deadline=$((SECONDS + timeout))
	until compose_all_healthy && curl --fail --silent --max-time 5 "$web_health_url" >/dev/null; do
		if [ "$SECONDS" -ge "$deadline" ]; then
			return 1
		fi
		sleep 2
	done
	return 0
}

public_health() {
	curl --fail --silent --show-error --max-time 10 "$public_health_url" >/dev/null
}

# The public check after a candidate starts: retried until `public_health_timeout`, because Caddy
# may still be obtaining the certificate (always so on a first deployment). Only the last
# attempt's error is shown.
wait_for_public_health() {
	local deadline=$((SECONDS + public_health_timeout))
	until curl --fail --silent --max-time 10 "$public_health_url" >/dev/null 2>&1; do
		if [ "$SECONDS" -ge "$deadline" ]; then
			public_health
			return
		fi
		sleep 3
	done
	return 0
}

verify_running_digest() {
	local web_container
	web_container="$(compose ps -q web)"
	[ -n "$web_container" ] || return 1
	# The container must run its exact requested digest reference, and the
	# local store must resolve that immutable identity.
	[ "$(docker inspect --format '{{.Config.Image}}' "$web_container")" = "$image" ] &&
		docker image inspect "$image" >/dev/null 2>&1
}

# Roll back to the last healthy release; with an empty environment, restore the
# recorded empty bootstrap state by removing the failed candidate. Restoring
# only the image digest cannot recover a configuration regression (the shipped
# Compose file, Caddyfile, or Centrifugo config), so when a snapshot exists
# this restores those files too and recreates every service, not only web:
# Caddy does not depend on web, and a Centrifugo config change only takes
# effect when Centrifugo itself is recreated.
rollback() {
	local target="$1"
	if [ -n "$target" ]; then
		if [ -d "$release_snapshot_dir" ]; then
			restore_release_snapshot
			printf 'restored the last healthy release configuration\n' >&2
			write_deploy_env "$target" "$checker_image"
			compose up -d --remove-orphans --wait --wait-timeout "$timeout" >/dev/null
		else
			printf 'no last healthy release snapshot; rolling back the image only\n' >&2
			write_deploy_env "$target" "$checker_image"
			compose up -d --wait --wait-timeout "$timeout" web >/dev/null
		fi
		if wait_for_health; then
			printf 'rolled back to the previous healthy digest\n' >&2
			return 0
		fi
		return 1
	fi
	# Verified empty environment: remove the failed candidate completely.
	compose down --remove-orphans >/dev/null 2>&1 || true
	printf 'removed the failed bootstrap candidate; empty state restored\n' >&2
	return 1
}

# One failure path for every failed check: roll back to the last healthy
# digest, or restore the verified empty state when there is none.
fail_deployment() {
	local reason="$1"
	candidate_diagnostics || true
	if rollback "$last_healthy"; then
		public_health || true
		prune_deploy_images
		report "$last_healthy" "$reason" "rolled_back" "$last_healthy"
	elif [ -z "$last_healthy" ]; then
		report "" "$reason; restored the empty bootstrap state" "bootstrap_failed" ""
	else
		report "$last_healthy" "$reason and rollback failed" "failed" ""
	fi
	exit 0
}

report() {
	printf 'previous_web_image=%s\nhealth_result=%s\noutcome=%s\nrollback_target=%s\n' \
		"${1:-}" "$2" "$3" "${4:-}"
	[ -z "$deploy_warning" ] || printf 'warning=%s\n' "$deploy_warning"
}

write_deploy_env "$image" "$checker_image"

# A candidate stopped before anything was recreated leaves its shipped files on
# the live paths (the workflow copied them before this script ran). Running
# containers keep the old ones, but a later Caddy or Centrifugo restart (host
# reboot, daemon restart) would load a file the guards below just rejected, so
# put the last healthy release's files and .env back.
discard_candidate_configuration() {
	[ -d "$release_snapshot_dir" ] || return 0
	restore_release_snapshot
	if [ -n "$current_image" ]; then
		write_deploy_env "$current_image" "$checker_image"
	fi
}

# Validate the rendered base-plus-environment configuration before mutating.
if ! compose config --quiet; then
	report "$current_image" "failed: compose configuration validation failed" "failed" ""
	exit 0
fi

# Validate the shipped Centrifugo configuration with the exact pinned image
# that will run it, before recreating anything. On 2026-09-18 two merged PRs
# each added a top-level `websocket:` key to this file; the duplicate key made
# Centrifugo exit at start, nothing here checked the config first, and
# `compose up -d --wait` recreated the live container straight into that
# failure. Centrifugo's own `checkconfig` subcommand parses the file exactly
# as `centrifugo` itself would at start.
#
# Pull the pinned image first, with its own reason: the one-off container
# below would otherwise pull it implicitly, and a registry failure must not
# be reported as a configuration failure.
if ! compose pull --quiet centrifugo >/dev/null; then
	discard_candidate_configuration
	report "$current_image" "failed: Centrifugo image pull failed" "failed" ""
	exit 0
fi
# shellcheck disable=SC2016 # single-quoted on purpose: the $(...) below must
# expand inside the centrifugo container's shell, not this host shell.
# It reads every secret the service reads, as the image's own user, and fails on
# one it cannot read or that is empty: on 2026-10-12 an unreadable secret came
# through as an empty value, checkconfig still passed, and the first production
# deploy migrated the database before Centrifugo failed to start.
if ! compose run --rm --no-deps --entrypoint sh centrifugo \
	-c 'set -e; secret() { value="$(cat "/run/secrets/$1")"; [ -n "$value" ] || { echo "centrifugo: secret $1 is unreadable or empty" >&2; return 1; }; printf "%s" "$value"; }; CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY="$(secret centrifugo_token_hmac_secret_key)"; CENTRIFUGO_HTTP_API_KEY="$(secret centrifugo_http_api_key)"; CENTRIFUGO_VAR_RPC_PROXY_SECRET="$(secret centrifugo_proxy_secret)"; CENTRIFUGO_ENGINE_REDIS_ADDRESS="$(secret redis_url)"; export CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY CENTRIFUGO_HTTP_API_KEY CENTRIFUGO_VAR_RPC_PROXY_SECRET CENTRIFUGO_ENGINE_REDIS_ADDRESS; exec centrifugo checkconfig -c /centrifugo/config.yaml' \
	</dev/null 1>&2; then
	discard_candidate_configuration
	report "$current_image" "failed: Centrifugo configuration validation failed" "failed" ""
	exit 0
fi

# Caddy is the only public entry and runs with its admin API off, so a
# Caddyfile it cannot load takes the whole site down when the container is
# recreated. `caddy validate` loads and provisions the file with the pinned
# image without starting servers or obtaining certificates; `--no-deps` keeps
# web and Centrifugo untouched and `run` publishes no ports.
if ! compose pull --quiet caddy >/dev/null; then
	discard_candidate_configuration
	report "$current_image" "failed: Caddy image pull failed" "failed" ""
	exit 0
fi
if ! compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
	</dev/null 1>&2; then
	discard_candidate_configuration
	report "$current_image" "failed: Caddy configuration validation failed" "failed" ""
	exit 0
fi

# Pulls the candidate by its digest with `docker pull`, which needs none of the Compose secrets.
# `--quiet` still prints the reference on stdout, which carries the report. On failure,
# `web_pull_failure` says how the last attempt ended.
pull_web_image() {
	local attempt status started detail
	for ((attempt = 1; attempt <= web_pull_attempts; attempt++)); do
		started=$SECONDS
		status=0
		timeout --kill-after=10s "${web_pull_deadline}s" docker pull --quiet "$image" >/dev/null || status=$?
		case "$status" in
		0) detail="succeeded in $((SECONDS - started))s" ;;
		# GNU timeout's statuses for a command it timed out, and for one it then had to KILL.
		124 | 137)
			web_pull_failure="timed out"
			detail="timed out after ${web_pull_deadline}s"
			;;
		*)
			web_pull_failure=failed
			detail="failed with exit status $status"
			;;
		esac
		printf 'Web image pull attempt %d of %d %s\n' "$attempt" "$web_pull_attempts" "$detail" >&2
		if [ "$status" -eq 0 ]; then
			return 0
		fi
	done
	return 1
}

if ! pull_web_image; then
	discard_candidate_configuration
	report "$current_image" "failed: Web image pull $web_pull_failure" "failed" ""
	exit 0
fi

if ! run_migrations; then
	report "$last_healthy" "failed: $migration_failure" "failed" ""
	exit 0
fi

if ! compose up -d --wait --wait-timeout "$timeout" >/dev/null; then
	fail_deployment "failed: candidate failed health verification"
fi

if ! verify_running_digest; then
	fail_deployment "failed: running container digest mismatch"
fi

if ! wait_for_public_health; then
	fail_deployment "failed: public readiness failed"
fi

snapshot_release

wait_for_wildcard_certificate

printf '%s\n' \
	"PREVIOUS_WEB_IMAGE=$current_image" \
	"CURRENT_WEB_IMAGE=$image" >"$state_file.tmp"
chmod 600 "$state_file.tmp"
mv "$state_file.tmp" "$state_file"

prune_deploy_images

report "$current_image" "healthy" "healthy" "$current_image"
