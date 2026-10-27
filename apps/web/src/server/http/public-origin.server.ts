/** The origin the browser actually reached. Behind the staging and production reverse
 * proxy the request URL carries the right host — Caddy passes the client's `Host` header
 * through, and the Bun server builds `request.url` from it — but the wrong scheme, because
 * TLS terminates at the proxy. So the scheme has to come from `X-Forwarded-Proto`, and the
 * host is taken from the same hop for consistency.
 *
 * The forwarded origin is rebuilt rather than patched onto the request URL: assigning a
 * portless host to a `URL` leaves whatever port was already there, which would be wrong for
 * any caller whose request URL does carry one. */
export function publicOrigin(request: Request): string {
  const requestOrigin = new URL(request.url).origin;
  const forwardedProto = firstHop(request.headers.get("x-forwarded-proto"));
  const forwardedHost = firstHop(request.headers.get("x-forwarded-host"));
  if (!forwardedProto || !forwardedHost) return requestOrigin;

  let forwarded: URL;
  try {
    forwarded = new URL(`${forwardedProto}://${forwardedHost}`);
  } catch {
    return requestOrigin;
  }
  // Anything but http(s) is a malformed hop rather than one to trust with the origin, and
  // some schemes are worse than useless: `file://evil.com` has an opaque origin, so `.origin`
  // is the literal string "null", which callers would happily paste into a shell command.
  if (forwarded.protocol !== "http:" && forwarded.protocol !== "https:") return requestOrigin;
  // A host carrying a path, credentials or a query is malformed the same way. Both halves of
  // the credential are checked: `:pw@evil.com` leaves `username` empty.
  if (forwarded.pathname !== "/" || forwarded.username || forwarded.password) {
    return requestOrigin;
  }
  if (forwarded.search) return requestOrigin;
  return forwarded.origin;
}

/** Proxies append to these headers, so only the client-facing hop is ours. */
function firstHop(value: string | null): string | undefined {
  return value?.split(",")[0].trim() || undefined;
}

/**
 * The address of the client that reached the reverse proxy, or `undefined` when the request
 * carries none we can trust to be one.
 *
 * Production traffic comes only through Caddy's `reverse_proxy` without `trusted_proxies`, which
 * discards the `X-Forwarded-*` values a client sent and writes `X-Forwarded-For` itself
 * (https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). The header therefore holds the
 * address Caddy saw, and an intermediate hop only if a client could have forged it. Unlike
 * `publicOrigin`, which reads the first hop, this reads the last: it is the one our own proxy
 * appended, so it is the only entry a client cannot choose. Anything that is not an IPv4 or IPv6
 * literal (`unknown`, a host name, an address with a port) is no address.
 */
export function clientAddress(request: Request): string | undefined {
  const hops = request.headers.get("x-forwarded-for")?.split(",");
  const last = hops?.[hops.length - 1]?.trim().toLowerCase();
  return last && isAddress(last) ? last : undefined;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** Whether `value` is an IPv4 or IPv6 literal. The URL parser is the strict IPv6 grammar, behind a
 * character check that keeps brackets, ports, paths and zone ids out of its host slot. */
function isAddress(value: string): boolean {
  if (IPV4.test(value)) return true;
  if (!/^[0-9a-f:.]+$/.test(value) || !value.includes(":")) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}
