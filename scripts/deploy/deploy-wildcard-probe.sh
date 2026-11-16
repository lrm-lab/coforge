#!/usr/bin/env bash
# Wildcard certificate probe for remote-deploy.sh. It defines functions and runs nothing; remote-deploy.sh sources it.

# The wildcard certificate is issued by DNS-01 on its own; a wrong key, a RAM source-IP mismatch or
# a missing RAM action fails it without touching coforge.cn's health. A trusted handshake on a fixed
# host under the sandbox domain, resolved to this host's Caddy, proves it. Never blocks or rolls back.
wait_for_wildcard_certificate() {
	[ -n "$wildcard_probe_host" ] || return 0
	local host="$wildcard_probe_host" deadline=$((SECONDS + wildcard_probe_timeout))
	until curl --silent --output /dev/null --max-time 10 --resolve "$host:443:127.0.0.1" "https://$host/" >/dev/null 2>&1; do
		if [ "$SECONDS" -ge "$deadline" ]; then
			deploy_warning="wildcard certificate for $host is not served yet and may still be issuing (expected on the first deploy after the change); if it persists see docs/operations/usercontent-certificate triage"
			return 0
		fi
		sleep 5
	done
}
