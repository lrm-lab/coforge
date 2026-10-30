#!/usr/bin/env bash
# Rolls back traffic to the previous slot in a Blue-Green deployment.
#
# Reads the active and previous slot from state.env, starts the previous
# container (which was preserved in stopped state), verifies readiness,
# switches Caddy upstream back, reloads Caddy, and stops the bad slot.

set -euo pipefail

usage() {
	printf 'usage: %s --compose-file FILE --state-file FILE [--project NAME] [--timeout SECONDS]\n' "$0" >&2
	exit 2
}

compose_file=
state_file=
project=coforge-staging
timeout=60

while [ "$#" -gt 0 ]; do
	case "$1" in
	--compose-file)
		compose_file="${2:?}"
		shift 2
		;;
	--state-file)
		state_file="${2:?}"
		shift 2
		;;
	--project)
		project="${2:?}"
		shift 2
		;;
	--timeout)
		timeout="${2:?}"
		shift 2
		;;
	*)
		printf 'unknown flag: %s\n' "$1" >&2
		usage
		;;
	esac
done

[ -n "$compose_file" ] || usage
[ -n "$state_file" ] || usage
[ -f "$state_file" ] || {
	printf 'rollback: state file %s does not exist\n' "$state_file" >&2
	exit 1
}

read_state_value() {
	grep -E "^$1=" "$state_file" 2>/dev/null | head -n 1 | cut -d= -f2- || true
}

active_slot="$(read_state_value ACTIVE_SLOT)"
previous_slot="$(read_state_value PREVIOUS_SLOT)"
current_image="$(read_state_value CURRENT_WEB_IMAGE)"
previous_image="$(read_state_value PREVIOUS_WEB_IMAGE)"

# Default slot handling if not explicitly recorded
active_slot="${active_slot:-blue}"
if [ -z "$previous_slot" ]; then
	if [ "$active_slot" = "blue" ]; then
		previous_slot="green"
	else
		previous_slot="blue"
	fi
fi

target_slot="$previous_slot"
printf 'rollback: initiating rollback from slot %s to previous slot %s...\n' "$active_slot" "$target_slot" >&2

# Determine target loopback readiness port: blue -> 18080, green -> 18081
target_port="18080"
[ "$target_slot" = "green" ] && target_port="18081"

# 1. Start target container
target_container="$(docker ps -a --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=web_$target_slot" -q | head -n 1)"
if [ -z "$target_container" ]; then
	target_container="$(docker ps -a --filter "name=${project}-web_${target_slot}" -q | head -n 1)"
fi

if [ -z "$target_container" ]; then
	printf 'rollback: target container for slot %s not found on host; cannot rollback\n' "$target_slot" >&2
	exit 1
fi

printf 'rollback: starting container %s (slot %s)...\n' "$target_container" "$target_slot" >&2
docker start "$target_container" >/dev/null

# 2. Wait for readiness on target container
deadline=$((SECONDS + timeout))
ready=false
while [ "$SECONDS" -lt "$deadline" ]; do
	status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 "http://127.0.0.1:${target_port}/ready" 2>/dev/null || true)"
	if [ "$status" = "200" ]; then
		ready=true
		break
	fi
	sleep 1
done

if [ "$ready" != "true" ]; then
	printf 'rollback: target container on slot %s failed readiness check on port %s within %ds\n' "$target_slot" "$target_port" "$timeout" >&2
	exit 1
fi

printf 'rollback: container on slot %s is ready\n' "$target_slot" >&2

# 3. Update Caddy upstream configuration
caddy_dir="$(dirname "$compose_file")/caddy"
upstream_file="$caddy_dir/upstream.caddy"
if [ ! -f "$upstream_file" ]; then
	upstream_file="$caddy_dir/Caddyfile"
fi

tmp_upstream="${upstream_file}.tmp.$$"
sed "s/web_${active_slot}:3000/web_${target_slot}:3000/g" "$upstream_file" > "$tmp_upstream"
mv "$tmp_upstream" "$upstream_file"

# 4. Reload Caddy
caddy_container="$(docker ps --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=caddy" -q | head -n 1)"
if [ -n "$caddy_container" ]; then
	if docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
		docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
		printf 'rollback: Caddy successfully reloaded to upstream web_%s:3000\n' "$target_slot" >&2
	fi
fi

# 5. Stop the failed active slot
current_container="$(docker ps --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=web_$active_slot" -q | head -n 1)"
if [ -n "$current_container" ]; then
	printf 'rollback: stopping failed container %s (slot %s)...\n' "$current_container" "$active_slot" >&2
	docker stop -t 15 "$current_container" >/dev/null 2>&1 || true
fi

# 6. Update state.env
printf '%s\n' \
	"ACTIVE_SLOT=$target_slot" \
	"PREVIOUS_SLOT=$active_slot" \
	"CURRENT_WEB_IMAGE=$previous_image" \
	"PREVIOUS_WEB_IMAGE=$current_image" >"${state_file}.tmp"
chmod 600 "${state_file}.tmp"
mv "${state_file}.tmp" "$state_file"

printf 'outcome=rolled_back\nactive_slot=%s\ncurrent_image=%s\nrollback_target=%s\n' \
	"$target_slot" "${previous_image:-}" "$active_slot"
