/**
 * Evaluates whether a target URL matches the NO_PROXY bypass rules.
 * Supports:
 * - '*' (matches all)
 * - 'hostname' or 'IP'
 * - 'hostname:port'
 * - '*.domain.com' and '.domain.com' (matches subdomains and domain itself)
 * - Comma or whitespace separated list of rules
 */
export function shouldBypassProxy(target: URL | string, noProxyValue?: string): boolean {
  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : target;
  } catch {
    return false;
  }
  const noProxy = (noProxyValue ?? process.env.NO_PROXY ?? process.env.no_proxy ?? "").trim();
  if (!noProxy) return false;

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const hostname = url.hostname.toLowerCase();

  return noProxy
    .toLowerCase()
    .split(/[,\s]+/)
    .some((entry) => {
      if (!entry) return false;
      if (entry === "*") return true;
      const match = entry.match(/^(.*):(\d+)$/);
      const host = match ? match[1]! : entry;
      if (match && match[2] !== port) return false;
      if (host.startsWith("*.")) {
        const domain = host.slice(2);
        return hostname === domain || hostname.endsWith(`.${domain}`);
      }
      if (host.startsWith(".")) {
        const domain = host.slice(1);
        return hostname === domain || hostname.endsWith(`.${domain}`);
      }
      return hostname === host;
    });
}
