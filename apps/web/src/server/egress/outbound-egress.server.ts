// oxlint-disable-next-line no-restricted-imports -- BlockList provides audited IPv4 and IPv6 subnet matching for the egress boundary.
import { BlockList } from "node:net";

type Address = { address: string; family: 4 | 6 };
export type ResolveAddresses = (hostname: string) => Promise<readonly Address[]>;

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
const publicIpv6Addresses = new BlockList();

publicIpv6Addresses.addSubnet("2000::", 3, "ipv6");

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

/** The resolved addresses of a hostname include one that is not public. */
export class NonPublicAddressError extends Error {
  constructor() {
    super("outbound endpoint must resolve only to public addresses");
    this.name = "NonPublicAddressError";
  }
}

/** The URL's scheme is not one this egress may use: only https. */
export class UnsupportedEgressSchemeError extends Error {
  constructor() {
    super("outbound endpoint scheme is not allowed");
    this.name = "UnsupportedEgressSchemeError";
  }
}

/** A proxy is configured in the environment, which Bun's `fetch` would send the request through
 * instead of to the pinned address. The message names the variable, never its value. */
export class EgressProxyConfiguredError extends Error {
  constructor(variable: string) {
    super(`outbound requests must not use a proxy, but ${variable} is set`);
    this.name = "EgressProxyConfiguredError";
  }
}

export type OutboundTarget = { hostname: string; address: string; family: 4 | 6 };

export type FetchOutboundRequest = (url: string, init: BunFetchRequestInit) => Promise<Response>;

export type OutboundEgressOptions = {
  resolve?: ResolveAddresses;
  fetch?: FetchOutboundRequest;
};

/** At most this many validated addresses of a hostname are tried for one request. */
export const OUTBOUND_MAX_ADDRESSES = 3;

/** The variables Bun's `fetch` reads a proxy from for an https request. `fetch` has no option that
 * turns them off (its `proxy` option can only name another proxy), so a proxied request would
 * bypass the address pinning: the default fetch refuses to run while one is set. */
const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;

const fetchWithoutProxy: FetchOutboundRequest = (url, init) => {
  const variable = PROXY_VARIABLES.find((name) => process.env[name]);
  if (variable) return Promise.reject(new EgressProxyConfiguredError(variable));
  return fetch(url, init);
};

const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";

/**
 * Every outbound HTTP request CoForge makes to an address a third party chose (Web Push endpoints,
 * app webhooks) goes through one of these. It resolves the hostname and requires every answer to
 * be public (no loopback, link-local, private, or other reserved range), then sends the request
 * pinned to a validated address, so a DNS rebind between the check and the request cannot reach
 * anywhere else. https only. A test points it at a receiver on this machine through the `resolve`
 * and `fetch` options, never through a branch here.
 */
export class OutboundEgress {
  private readonly resolve: ResolveAddresses;
  private readonly fetchImpl: FetchOutboundRequest;

  constructor(options: OutboundEgressOptions = {}) {
    this.resolve =
      options.resolve ??
      ((hostname) => Bun.dns.lookup(hostname, { backend: "system" }) as Promise<Address[]>);
    this.fetchImpl = options.fetch ?? fetchWithoutProxy;
  }

  /**
   * Resolves the URL's hostname (an IPv6 literal without its brackets) and validates that every
   * returned address is public. Returns the hostname with the first validated address to pin the
   * request to. Resolve again for every request: DNS may change between two.
   */
  async resolveTarget(url: string): Promise<OutboundTarget> {
    return (await this.resolveTargets(url))[0]!;
  }

  /** Like `resolveTarget`, with up to `OUTBOUND_MAX_ADDRESSES` distinct validated addresses in
   * the order the resolver gave them. */
  async resolveTargets(url: string): Promise<OutboundTarget[]> {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:") throw new UnsupportedEgressSchemeError();
    const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    const addresses = await this.resolve(bare);
    if (addresses.length === 0 || !addresses.every(isPublic)) throw new NonPublicAddressError();
    const distinct = [...new Map(addresses.map((a) => [a.address, a])).values()];
    return distinct
      .slice(0, OUTBOUND_MAX_ADDRESSES)
      .map(({ address, family }) => ({ hostname, address, family }));
  }

  /**
   * Sends the request to the validated address, bypassing DNS entirely. The TLS certificate is
   * still verified against the real hostname (`tls.serverName`), and `Host` keeps it. Redirects
   * are never followed (`redirect: "manual"`): a redirect is just another status.
   * `AbortSignal.timeout` bounds the whole request, connect and handshake included;
   * `keepalive: false` keeps a pinned connection from being reused for another target. The
   * response body is cancelled unread, so nothing a third party answers is ever held.
   */
  async send(
    url: string,
    request: { method: string; headers?: Record<string, string>; body?: BodyInit },
    target: OutboundTarget,
    timeoutMs: number,
  ): Promise<{ status: number }> {
    const endpoint = new URL(url);
    if (endpoint.hostname !== target.hostname) {
      throw new Error("outbound hostname changed after validation");
    }
    if (endpoint.protocol !== "https:") throw new UnsupportedEgressSchemeError();
    const pinnedHost = target.family === 6 ? `[${target.address}]` : target.address;
    const pinnedUrl = `https://${pinnedHost}${endpoint.port ? `:${endpoint.port}` : ""}${endpoint.pathname}${endpoint.search}`;
    const hostHeader = endpoint.port ? `${target.hostname}:${endpoint.port}` : target.hostname;
    const response = await this.fetchImpl(pinnedUrl, {
      method: request.method,
      headers: { ...request.headers, Host: hostHeader },
      body: request.body,
      tls: { serverName: endpoint.hostname.replace(/^\[|\]$/g, "") },
      redirect: "manual",
      keepalive: false,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return { status: response.status };
  }

  /**
   * Resolves, then sends to the first validated address that accepts a connection, trying the
   * next (at most `OUTBOUND_MAX_ADDRESSES`) when a request fails before any status arrives. One
   * deadline, `timeoutMs`, covers all of them; a timeout or a proxy refusal ends the attempts.
   */
  async sendToAny(
    url: string,
    request: { method: string; headers?: Record<string, string>; body?: BodyInit },
    timeoutMs: number,
  ): Promise<{ status: number }> {
    const targets = await this.resolveTargets(url);
    const deadline = Date.now() + timeoutMs;
    let failure: unknown;
    for (const target of targets) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        return await this.send(url, request, target, remaining);
      } catch (error) {
        if (isTimeout(error) || error instanceof EgressProxyConfiguredError) throw error;
        failure = error;
      }
    }
    throw failure ?? new DOMException("The operation timed out.", "TimeoutError");
  }
}

function isPublic({ address, family }: Address): boolean {
  return family === 4
    ? !blockedIpv4Addresses.check(address, "ipv4")
    : publicIpv6Addresses.check(address, "ipv6") && !blockedIpv6Addresses.check(address, "ipv6");
}
