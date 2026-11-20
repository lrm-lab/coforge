#!/usr/bin/env bash
# Bounded failure diagnostics for remote-deploy.sh: fixed vocabulary codes, never raw logs. It defines functions and runs nothing; remote-deploy.sh sources it.

# Read only bounded candidate evidence before rollback destroys the container.
# Never print raw logs, inspect JSON, health output, URLs, or error messages:
# any can contain credentials or user data not known to this deployment script.
# Each Docker call has a 5s deadline plus a 1s forced-kill grace period.
# Unavailable diagnostics cannot block rollback.
candidate_diagnostics() {
	local container state logs status
	printf 'candidate diagnostics (allowlisted metadata and startup signatures only)\n' >&2
	container="$(timeout --kill-after=1s 5s docker ps --filter "label=com.docker.compose.project=$project" \
		--filter label=com.docker.compose.service=web --all --format '{{.ID}}' 2>/dev/null | head -n 1)" || true
	if [[ "$container" =~ ^[0-9a-f]{6,64}$ ]]; then
		state="$(timeout --kill-after=1s 5s docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" || true
		if [[ "$state" =~ ^(created|running|paused|restarting|removing|exited|dead)\ [0-9]+\ [0-9]+\ (none|starting|healthy|unhealthy)$ ]]; then
			printf 'candidate state/exit/restarts/health: %s\n' "$state" >&2
		fi
		logs="$(timeout --kill-after=1s 5s docker logs --tail 80 --since 5m "$container" 2>&1 | head -c 16384)" || true
		if [[ "$logs" == *'createSsrRpc is not a function'* ]]; then
			printf 'startup_signature=createSsrRpc\n' >&2
		elif [[ "$logs" == *'Cannot find module'* || "$logs" == *'ModuleNotFound'* ]]; then
			printf 'startup_signature=missing_module\n' >&2
		elif [[ "$logs" == *'SyntaxError'* || "$logs" == *'ReferenceError'* || "$logs" == *'TypeError'* ]]; then
			printf 'startup_signature=javascript_initialization_error\n' >&2
		else
			printf 'startup_signature=unclassified_or_unavailable\n' >&2
		fi
	fi
	status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$web_health_url" 2>/dev/null)" || true
	if [[ "$status" =~ ^[0-9]{3}$ ]]; then
		printf 'candidate loopback health HTTP status: %s\n' "$status" >&2
	fi
	if [[ "$container" =~ ^[0-9a-f]{6,64}$ ]]; then
		release_feed_diagnostics "$container" || true
	fi
	proxy_diagnostics || true
	return 0
}

# Probe the candidate's ordinary user, environment and Bun fetch, without
# changing the running Web cache or network. The request gets the Web's 3s
# budget; the Docker call gets 5s plus 1s forced-kill grace. Only fixed codes
# leave the container, never a URL, body, or arbitrary error.
release_feed_diagnostics() {
	local result
	result="$(timeout --kill-after=1s 5s docker exec "$1" bun -e '
const feed = Bun.env.COFORGE_RELEASE_FEED_URL?.trim().replace(/\/$/, "");
let result = "unconfigured";
if (feed) {
  result = "unsupported_feed";
  if (["https://releases-staging.coforge.cn", "https://releases.coforge.cn"].includes(feed)) {
    try {
      const response = await fetch(feed + "/latest", { signal: AbortSignal.timeout(3000) });
      result = "http_error";
      if (response.ok) {
        result = "invalid_version";
        const reader = response.body?.getReader();
        if (reader) {
          let text = "", size = 0;
          const decoder = new TextDecoder();
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > 128) break;
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
            // Match the Web reader: SDK internal/release-version.ts isValidReleaseVersion.
            const version = text.trim();
            if (size <= 128 && /^[A-Za-z0-9.+-]{1,100}$/.test(version)
                && version !== "." && !version.includes("..") && !version.startsWith("-")) result = "available";
          } finally { await reader.cancel().catch(() => {}); }
        }
      } else { await response.body?.cancel(); }
    } catch (error) {
      const code = error?.code;
      result = error?.name === "TimeoutError" || code === "ETIMEDOUT" ? "timeout"
        : ["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "DNS_LOOKUP_FAILED"].includes(code) ? "dns_error"
        : typeof code === "string" && /^(CERT_|ERR_TLS_|SSL_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT)/.test(code) ? "tls_error"
        : "network_error";
    }
  }
}
console.log(result);
' 2>/dev/null | head -c 64)" || true
	case "$result" in
	available | unconfigured | unsupported_feed | http_error | invalid_version | timeout | dns_error | tls_error | network_error) ;;
	*) result=unavailable ;;
	esac
	printf 'candidate release feed: %s\n' "$result" >&2
}

# The reverse proxy owns the public entry, so its certificate state is the
# difference between "the application is up but 443 cannot complete a TLS
# handshake" and "the application itself is broken". Classify it the way the
# web container's startup signature is classified: read a bounded slice of the
# proxy's log, print only a fixed vocabulary code, never the log itself.
proxy_diagnostics() {
	local container logs state
	container="$(timeout --kill-after=1s 5s docker ps --filter "label=com.docker.compose.project=$project" \
		--filter label=com.docker.compose.service=caddy --all --format '{{.ID}}' 2>/dev/null | head -n 1)" || true
	[[ "$container" =~ ^[0-9a-f]{6,64}$ ]] || return 0
	state="$(timeout --kill-after=1s 5s docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" || true
	if [[ "$state" =~ ^(created|running|paused|restarting|removing|exited|dead)\ [0-9]+\ [0-9]+\ (none|starting|healthy|unhealthy)$ ]]; then
		printf 'proxy state/exit/restarts/health: %s\n' "$state" >&2
	fi
	logs="$(timeout --kill-after=1s 5s docker logs --tail 120 --since 10m "$container" 2>&1 | head -c 16384)" || true
	case "$logs" in
	*'certificate obtained successfully'*) printf 'proxy_signature=certificate_obtained\n' >&2 ;;
	*'connection refused'* | *'i/o timeout'* | *'no route to host'*)
		printf 'proxy_signature=acme_challenge_unreachable\n' >&2
		;;
	*'rate limit'* | *'too many certificates'*) printf 'proxy_signature=acme_rate_limited\n' >&2 ;;
	*'permission denied'* | *'read-only file system'*)
		printf 'proxy_signature=certificate_storage_denied\n' >&2
		;;
	*'could not get certificate'* | *'acme'* | *'obtain'*) printf 'proxy_signature=acme_failed\n' >&2 ;;
	*) printf 'proxy_signature=unclassified_or_unavailable\n' >&2 ;;
	esac
	return 0
}

probe_artifact_checker() {
	[ -n "${checker_image:-}" ] && [ -f "${checker_compose_file:-}" ] || return 0
	local container result
	container="$(timeout --kill-after=1s 5s docker ps --filter "label=com.docker.compose.project=$project" \
		--filter label=com.docker.compose.service=web --format '{{.ID}}' 2>/dev/null | head -n 1)" || true
	if ! [[ "$container" =~ ^[0-9a-f]{6,64}$ ]]; then
		result=unavailable
	else
		result="$(timeout --kill-after=1s 25s docker exec "$container" bun -e '
const workerSocket = Bun.env.COFORGE_ARTIFACT_CHECK_WORKER_SOCKET?.trim() ?? "";
const workerUrl = (Bun.env.COFORGE_ARTIFACT_CHECK_WORKER_URL?.trim() || (workerSocket ? "http://artifact-checker" : "")).replace(/\/+$/, "");
const secret = Bun.env.COFORGE_ARTIFACT_CHECK_SECRET?.trim() ?? "";
let result = "env_missing";
if ((workerSocket || workerUrl) && secret) {
  try {
    const html = "<!doctype html><html><body style=\"margin:0\"><canvas id=\"c\" width=\"120\" height=\"80\"></canvas><script>const g=document.getElementById(\"c\").getContext(\"2d\");g.fillStyle=\"#1570ef\";g.fillRect(0,0,120,80);</script></body></html>";
    const res = await fetch(workerUrl + "/check", {
      method: "POST",
      ...(workerSocket ? { unix: workerSocket } : {}),
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
      body: JSON.stringify({
        checkId: "deploy-probe",
        origin: "https://a-deployprobe.coforge.check",
        entryPath: "index.html",
        csp: "",
        runtimeJs: "",
        allowedCdnHosts: [],
        files: [{ path: "index.html", contentType: "text/html; charset=utf-8", base64: Buffer.from(html).toString("base64") }],
        viewports: [{ shot: "desktop", width: 1280, height: 800, deviceScaleFactor: 1, mode: "panel" }],
        timeoutMs: 18000,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      result = res.status === 408 || res.status === 504 ? "timeout" : res.status >= 500 ? "http_5xx" : "http_4xx";
      await res.body?.cancel();
    } else {
      try {
        const data = await res.json();
        result = data && data.findings && !data.findings.blank && Array.isArray(data.screenshots) && data.screenshots.length === 1 ? "ok" : "invalid_response";
      } catch {
        result = "invalid_response";
      }
    }
  } catch (error) {
    result = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "unreachable";
  }
}
console.log(result);
' 2>/dev/null | head -c 64)" || true
	fi
	case "$result" in
	ok | env_missing | http_4xx | http_5xx | invalid_response | timeout | unreachable) ;;
	*) result=unavailable ;;
	esac
	printf 'artifact-checker live probe: %s\n' "$result" >&2
	if [ "$result" != ok ]; then
		deploy_warning="${deploy_warning:+$deploy_warning; }artifact-checker live probe returned $result"
	fi
	return 0
}
