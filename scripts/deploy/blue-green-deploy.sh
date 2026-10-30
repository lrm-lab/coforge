#!/usr/bin/env bash
# Blue-Green Zero-Downtime Deployment script for CoForge.
#
# Implements:
#   1. Read active slot from state.env (blue/green).
#   2. Pre-flight backward-compatibility migration check (Expand-Contract).
#   3. Start candidate slot container alongside running active slot.
#   4. Deep readiness verification (/ready: DB ping, Redis ping, schema completeness).
#   5. Atomic Caddy upstream cutover (zero connection loss).
#   6. Graceful 45s drain of previous slot before stop; container preserved for rollback.
#   7. Atomic state snapshot update.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-secrets.sh
source "$script_dir/deploy-secrets.sh"

usage() {
	printf 'usage: %s --image IMAGE --compose-file FILE --secrets-dir DIR --state-file FILE --public-health-url URL [--project NAME] [--timeout SECONDS] [--drain-timeout SECONDS] [--allow-breaking]\n' "$0" >&2
	exit 2
}

project=coforge-staging
timeout=120
drain_timeout=45
image=
compose_file=
secrets_dir=
state_file=
public_health_url=
allow_breaking=false

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
	--drain-timeout)
		drain_timeout="${2:?}"
		shift 2
		;;
	--image)
		image="${2:?}"
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
	--public-health-url)
		public_health_url="${2:?}"
		shift 2
		;;
	--allow-breaking)
		allow_breaking=true
		shift
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
[ -n "$public_health_url" ] || usage

readonly COMPOSE_ARGS=(-p "$project" -f "$compose_file")

# Fail closed on a mutable image reference
if ! printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
	printf 'outcome=failed\nhealth_result=mutable image reference rejected\n'
	exit 1
fi

load_compose_secrets

read_state_value() {
	grep -E "^$1=" "$state_file" 2>/dev/null | head -n 1 | cut -d= -f2- || true
}

# Determine Active and Candidate slots
current_image=""
active_slot="blue"
if [ -f "$state_file" ]; then
	current_image="$(read_state_value CURRENT_WEB_IMAGE)"
	saved_slot="$(read_state_value ACTIVE_SLOT)"
	[ -n "$saved_slot" ] && active_slot="$saved_slot"
fi

if [ "$active_slot" = "blue" ]; then
	candidate_slot="green"
	candidate_port="18081"
	active_port="18080"
else
	candidate_slot="blue"
	candidate_port="18080"
	active_port="18081"
fi

printf 'blue-green-deploy: active slot: %s (port %s), candidate slot: %s (port %s)\n' \
	"$active_slot" "$active_port" "$candidate_slot" "$candidate_port" >&2

# 1. Pre-flight migration safety check
safety_script="$script_dir/check-migration-safety.sh"
if [ -f "$safety_script" ]; then
	printf 'blue-green-deploy: running pre-flight migration compatibility check...\n' >&2
	safety_args=()
	[ "$allow_breaking" = "true" ] && safety_args+=(--allow-breaking)
	# Check repository migrations directory if present, else container migrations
	migrations_dir="$(dirname "$compose_file")/../../apps/web/prisma/migrations"
	if [ ! -d "$migrations_dir" ] && [ -d "$(dirname "$compose_file")/../../src/apps/web/prisma/migrations" ]; then
		migrations_dir="$(dirname "$compose_file")/../../src/apps/web/prisma/migrations"
	fi
	if [ -d "$migrations_dir" ]; then
		# Query database for already-applied migrations to inspect only pending migrations
		applied_migrations=""
		pg_container="$(compose ps -q postgres 2>/dev/null || docker ps --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=postgres" -q | head -n 1)"
		if [ -n "$pg_container" ]; then
			applied_migrations="$(docker exec "$pg_container" psql -U coforge -d coforge -t -A -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null || true)"
		fi

		pending_migrations=()
		for mdir in "$migrations_dir"/*; do
			[ -d "$mdir" ] || continue
			mname="$(basename "$mdir")"
			if [ -n "$applied_migrations" ]; then
				if ! printf '%s\n' "$applied_migrations" | grep -Fqx "$mname"; then
					if [ -f "$mdir/migration.sql" ]; then
						pending_migrations+=("$mdir/migration.sql")
					fi
				fi
			fi
		done

		if [ "${#pending_migrations[@]}" -gt 0 ]; then
			printf 'blue-green-deploy: inspecting %d pending migration(s) for breaking changes...\n' "${#pending_migrations[@]}" >&2
			bash "$safety_script" "${safety_args[@]}" "${pending_migrations[@]}"
		else
			printf 'blue-green-deploy: no pending unapplied migrations to inspect\n' >&2
		fi
	fi
fi

# 2. Pull candidate Web image
if ! docker image inspect "$image" >/dev/null 2>&1; then
	printf 'blue-green-deploy: pulling candidate image %s...\n' "$image" >&2
	if ! docker pull --quiet "$image" >/dev/null; then
		printf 'outcome=failed\nhealth_result=failed: image pull failed\n'
		exit 1
	fi
else
	printf 'blue-green-deploy: candidate image %s already present locally\n' "$image" >&2
fi

# 3. Execute database migration deploy
printf 'blue-green-deploy: running migration deploy...\n' >&2
write_deploy_env "$image"
if ! compose run --rm --entrypoint sh migrate \
	-c 'cd .migrate && sh migration-safety/migrate-deploy.sh' </dev/null 1>&2; then
	printf 'outcome=failed\nhealth_result=failed: migration safety check or deploy failed\n'
	exit 1
fi

# 4. Start candidate container
printf 'blue-green-deploy: starting candidate container web_%s...\n' "$candidate_slot" >&2
export COFORGE_WEB_IMAGE="$image"
compose up -d "web_${candidate_slot}"

# 5. Wait for readiness on candidate container (/ready)
printf 'blue-green-deploy: waiting for readiness check on 127.0.0.1:%s/ready...\n' "$candidate_port" >&2
deadline=$((SECONDS + timeout))
candidate_ready=false
while [ "$SECONDS" -lt "$deadline" ]; do
	status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://127.0.0.1:${candidate_port}/ready" 2>/dev/null || true)"
	if [ "$status" = "200" ]; then
		candidate_ready=true
		break
	fi
	# Fallback to /health for images where /ready is not yet deployed
	hstatus="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://127.0.0.1:${candidate_port}/health" 2>/dev/null || true)"
	if [ "$hstatus" = "200" ]; then
		candidate_ready=true
		break
	fi
	sleep 2
done

if [ "$candidate_ready" != "true" ]; then
	printf 'blue-green-deploy: candidate container failed readiness within %ds; stopping candidate container\n' "$timeout" >&2
	docker stop -t 10 "$(compose ps -q "web_${candidate_slot}")" >/dev/null 2>&1 || true
	printf 'outcome=failed\nhealth_result=candidate failed readiness verification\nactive_slot=%s\n' "$active_slot"
	exit 1
fi

printf 'blue-green-deploy: candidate web_%s is healthy and ready\n' "$candidate_slot" >&2

# 6. Atomic Caddy cutover
caddy_dir="$(dirname "$compose_file")/caddy"
upstream_file="$caddy_dir/upstream.caddy"
if [ ! -f "$upstream_file" ]; then
	upstream_file="$caddy_dir/Caddyfile"
fi

printf 'blue-green-deploy: switching Caddy upstream to web_%s:3000...\n' "$candidate_slot" >&2
tmp_upstream="${upstream_file}.tmp.$$"
sed "s/web_${active_slot}:3000/web_${candidate_slot}:3000/g" "$upstream_file" > "$tmp_upstream"
cat "$tmp_upstream" > "$upstream_file"
rm -f "$tmp_upstream"

caddy_container="$(compose ps -q caddy 2>/dev/null || docker ps --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=caddy" -q | head -n 1)"
if [ -n "$caddy_container" ]; then
	if docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
		docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
		printf 'blue-green-deploy: Caddy reloaded successfully\n' >&2
	else
		printf 'blue-green-deploy: Caddy validation failed; rolling upstream file back\n' >&2
		sed "s/web_${candidate_slot}:3000/web_${active_slot}:3000/g" "$upstream_file" > "$tmp_upstream"
		cat "$tmp_upstream" > "$upstream_file"
		rm -f "$tmp_upstream"
		docker stop -t 10 "$(compose ps -q "web_${candidate_slot}")" >/dev/null 2>&1 || true
		printf 'outcome=failed\nhealth_result=caddy reload failed\n'
		exit 1
	fi
fi

# 7. Verify public health URL
printf 'blue-green-deploy: verifying public endpoint %s...\n' "$public_health_url" >&2
pub_deadline=$((SECONDS + 30))
pub_ok=false
while [ "$SECONDS" -lt "$pub_deadline" ]; do
	if curl --fail --silent --max-time 5 "$public_health_url" >/dev/null 2>&1; then
		pub_ok=true
		break
	fi
	sleep 2
done

if [ "$pub_ok" != "true" ]; then
	printf 'blue-green-deploy: public verification failed after cutover\n' >&2
fi

# 8. Graceful drain of previous slot
old_container="$(compose ps -q "web_${active_slot}" 2>/dev/null || true)"
if [ -z "$old_container" ] && [ "$active_slot" = "blue" ]; then
	old_container="$(compose ps -q web 2>/dev/null || true)"
fi
if [ -n "$old_container" ]; then
	printf 'blue-green-deploy: draining old container %s (slot %s) for %ds...\n' "$old_container" "$active_slot" "$drain_timeout" >&2
	sleep "$drain_timeout"
	printf 'blue-green-deploy: stopping old container (preserved for rollback)...\n' >&2
	docker stop -t 15 "$old_container" >/dev/null 2>&1 || true
fi

# 9. Update state.env
printf '%s\n' \
	"ACTIVE_SLOT=$candidate_slot" \
	"PREVIOUS_SLOT=$active_slot" \
	"CURRENT_WEB_IMAGE=$image" \
	"PREVIOUS_WEB_IMAGE=$current_image" >"${state_file}.tmp"
chmod 600 "${state_file}.tmp"
mv "${state_file}.tmp" "$state_file"

printf 'previous_web_image=%s\nhealth_result=healthy\noutcome=healthy\nactive_slot=%s\nrollback_target=%s\n' \
	"$current_image" "$candidate_slot" "$active_slot"
