#!/usr/bin/env bash
# Checks a deployed public entry: plain HTTP answers only with a permanent
# redirect to the same URL over HTTPS (and never sends HSTS, which is valid
# only over HTTPS), and HTTPS responses carry Strict-Transport-Security.
set -euo pipefail

host="${1:?usage: check-https-entry.sh <host>}"
probe="/health?https-entry-check=1"

http_response="$(curl --silent --show-error --max-time 10 --output /dev/null \
	--dump-header - "http://$host$probe")"
status="$(printf '%s' "$http_response" | awk 'NR == 1 { print $2 }')"
location="$(printf '%s' "$http_response" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"

if [ "$status" != 301 ] && [ "$status" != 308 ]; then
	printf 'check-https-entry: http://%s%s answered %s, not a permanent redirect\n' \
		"$host" "$probe" "${status:-nothing}" >&2
	exit 1
fi
if [ "$location" != "https://$host$probe" ]; then
	printf 'check-https-entry: http://%s%s redirects to %s, not the same URL over HTTPS\n' \
		"$host" "$probe" "${location:-nothing}" >&2
	exit 1
fi
if printf '%s' "$http_response" | grep -qi '^strict-transport-security:'; then
	printf 'check-https-entry: the HTTP redirect sends Strict-Transport-Security\n' >&2
	exit 1
fi

if ! curl --silent --show-error --max-time 10 --output /dev/null --dump-header - \
	"https://$host/health" | grep -qi '^strict-transport-security: *max-age=[1-9]'; then
	printf 'check-https-entry: https://%s/health sends no Strict-Transport-Security max-age\n' \
		"$host" >&2
	exit 1
fi

printf 'check-https-entry: %s redirects HTTP to HTTPS and sends HSTS\n' "$host"
