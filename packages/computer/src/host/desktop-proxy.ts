import { randomBytes, timingSafeEqual } from "node:crypto";
import { adaptDesktopHtml, withDesktopTitle } from "./desktop-page";

export { adaptDesktopHtml, withDesktopTitle };

/** Caddy sets this when reverse-proxying after forward_auth; browsers never send it. */
export const DESKTOP_PROXY_SECRET_HEADER = "x-coforge-desktop-proxy-secret";

/**
 * Bun's default WebSocket idleTimeout is 120s. A still desktop rarely sends
 * frames, so the proxy would close the browser socket and leave a black noVNC
 * canvas. Bun's maximum is 960s; with sendPings the client pong refreshes it.
 */
export const DESKTOP_WEBSOCKET_IDLE_TIMEOUT_SECONDS = 960;

export const DESKTOP_ENDPOINT_CACHE_TTL_MS = 5_000;
export const DESKTOP_ENDPOINT_CACHE_MAX_ENTRIES = 256;
export const DESKTOP_WS_MAX_QUEUED_FRAMES = 64;
export const DESKTOP_WS_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

export type DesktopEndpoint = { host: string; port: number; token: string };

export function desktopProxySecretAllows(
  request: Request,
  expectedSecret: string | undefined,
): boolean {
  const expected = expectedSecret?.trim() ?? "";
  if (expected.length === 0) return true;
  const presented = request.headers.get(DESKTOP_PROXY_SECRET_HEADER) ?? "";
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

type SocketData = {
  computerId: string;
  opened: boolean;
  upstream?: WebSocket;
  queue: Array<string | ArrayBuffer>;
  queuedBytes: number;
  target: DesktopEndpoint;
  upstreamPath: string;
};

function frame(message: string | Buffer): string | ArrayBuffer {
  if (typeof message === "string") return message;
  const copy = new ArrayBuffer(message.byteLength);
  new Uint8Array(copy).set(message);
  return copy;
}

export function newDesktopToken(): string {
  return randomBytes(24).toString("base64url");
}

const DESKTOP_ASSET = new Set(["websockify", "core", "vendor", "app", "desktop.html"]);

export function parseDesktopRoute(
  pathname: string,
): { computerId: string; upstreamPath: string } | undefined {
  const match = /^\/desktop\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname.replace(/\/{2,}/g, "/"));
  if (!match?.[1]) return undefined;
  const computerId = match[1];
  const suffix = match[2] ?? "/";
  const parts = suffix.split("/").filter((part) => part.length > 0);
  if (
    parts.length === 1 &&
    (parts[0] === "fill" || parts[0] === "inspect" || parts[0] === "clipboard")
  ) {
    return { computerId, upstreamPath: `/${parts[0]}` };
  }
  if (
    parts.length === 2 &&
    (parts[1] === "fill" || parts[1] === "inspect" || parts[1] === "clipboard") &&
    parts[0] &&
    !DESKTOP_ASSET.has(parts[0])
  ) {
    return { computerId, upstreamPath: `/screen/${parts[0]}/${parts[1]}` };
  }
  const agentId = parts[0];
  if (agentId && !DESKTOP_ASSET.has(agentId)) {
    const tail = parts.slice(1).join("/");
    const upstreamPath =
      tail.length === 0 || tail === "desktop.html"
        ? `/screen/${agentId}/desktop.html`
        : `/screen/${agentId}/${tail}`;
    return { computerId, upstreamPath };
  }
  return {
    computerId,
    upstreamPath: suffix === "/" ? "/desktop.html" : suffix,
  };
}

function sameEndpoint(a: DesktopEndpoint, b: DesktopEndpoint): boolean {
  return a.host === b.host && a.port === b.port && a.token === b.token;
}

export function startDesktopProxy(input: {
  hostname: string;
  port: number;
  resolve: (computerId: string) => Promise<DesktopEndpoint | undefined>;
  handleRequest?: (request: Request) => Promise<Response | undefined>;
  proxySecret?: string;
  endpointCacheTtlMs?: number;
  now?: () => number;
}): { port: number; stop: () => void } {
  const ttlMs = input.endpointCacheTtlMs ?? DESKTOP_ENDPOINT_CACHE_TTL_MS;
  const now = input.now ?? Date.now;
  const cache = new Map<string, { endpoint: DesktopEndpoint; expiresAt: number }>();
  type InflightEntry = {
    promise: Promise<DesktopEndpoint | undefined>;
    failedEndpoint?: DesktopEndpoint;
  };
  const inflight = new Map<string, InflightEntry>();

  function invalidateEndpoint(computerId: string, failedEndpoint: DesktopEndpoint): void {
    const cached = cache.get(computerId);
    if (cached && sameEndpoint(cached.endpoint, failedEndpoint)) {
      cache.delete(computerId);
    }
    const pending = inflight.get(computerId);
    if (
      pending &&
      (!pending.failedEndpoint || !sameEndpoint(pending.failedEndpoint, failedEndpoint))
    ) {
      inflight.delete(computerId);
    }
  }

  async function resolveEndpoint(
    computerId: string,
    failedEndpoint?: DesktopEndpoint,
  ): Promise<{ target: DesktopEndpoint | undefined; fromCache: boolean }> {
    if (failedEndpoint) invalidateEndpoint(computerId, failedEndpoint);
    if (ttlMs > 0) {
      const cached = cache.get(computerId);
      if (cached) {
        if (cached.expiresAt > now()) {
          return { target: cached.endpoint, fromCache: true };
        }
        cache.delete(computerId);
      }
    }
    const existing = inflight.get(computerId);
    if (existing) {
      return { target: await existing.promise, fromCache: false };
    }
    const entry: InflightEntry = {
      promise: Promise.resolve(undefined),
      failedEndpoint,
    };
    entry.promise = input
      .resolve(computerId)
      .then((endpoint) => {
        if (endpoint && ttlMs > 0 && inflight.get(computerId) === entry) {
          cache.delete(computerId);
          if (cache.size >= DESKTOP_ENDPOINT_CACHE_MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(computerId, { endpoint, expiresAt: now() + ttlMs });
        }
        return endpoint;
      })
      .finally(() => {
        if (inflight.get(computerId) === entry) inflight.delete(computerId);
      });
    inflight.set(computerId, entry);
    return { target: await entry.promise, fromCache: false };
  }

  const server = Bun.serve<SocketData>({
    hostname: input.hostname,
    port: input.port,
    async fetch(request, bun) {
      const handled = await input.handleRequest?.(request);
      if (handled) return handled;
      const url = new URL(request.url);
      const route = parseDesktopRoute(url.pathname);
      if (!route) return new Response("not found", { status: 404 });
      if (!desktopProxySecretAllows(request, input.proxySecret)) {
        return new Response("forbidden", { status: 403 });
      }
      let resolved: { target: DesktopEndpoint | undefined; fromCache: boolean };
      try {
        resolved = await resolveEndpoint(route.computerId);
      } catch {
        console.error("[desktop] lookup failed");
        return new Response("desktop lookup failed", { status: 502 });
      }
      if (!resolved.target) return new Response("desktop is not running", { status: 404 });
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = bun.upgrade(request, {
          data: {
            computerId: route.computerId,
            opened: false,
            queue: [],
            queuedBytes: 0,
            target: resolved.target,
            upstreamPath: route.upstreamPath,
          },
        });
        return upgraded ? undefined : new Response("websocket upgrade failed", { status: 400 });
      }
      try {
        return await proxyHttp(request, resolved.target, route.upstreamPath, url.search);
      } catch {
        invalidateEndpoint(route.computerId, resolved.target);
        if (!resolved.fromCache || (request.method !== "GET" && request.method !== "HEAD")) {
          return new Response("desktop upstream unavailable", { status: 502 });
        }
        let refreshed: { target: DesktopEndpoint | undefined; fromCache: boolean };
        try {
          refreshed = await resolveEndpoint(route.computerId, resolved.target);
        } catch {
          console.error("[desktop] lookup failed");
          return new Response("desktop lookup failed", { status: 502 });
        }
        if (!refreshed.target) return new Response("desktop is not running", { status: 404 });
        try {
          return await proxyHttp(request, refreshed.target, route.upstreamPath, url.search);
        } catch {
          invalidateEndpoint(route.computerId, refreshed.target);
          return new Response("desktop upstream unavailable", { status: 502 });
        }
      }
    },
    websocket: {
      idleTimeout: DESKTOP_WEBSOCKET_IDLE_TIMEOUT_SECONDS,
      sendPings: true,
      open(ws) {
        const { target, upstreamPath } = ws.data;
        const upstream = new WebSocket(
          `ws://${target.host}:${target.port}${upstreamPath}?token=${encodeURIComponent(target.token)}`,
        );
        ws.data.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        upstream.addEventListener("open", () => {
          ws.data.opened = true;
          for (const item of ws.data.queue) upstream.send(item);
          ws.data.queue = [];
          ws.data.queuedBytes = 0;
        });
        upstream.addEventListener("message", (event) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(event.data);
        });
        const closeBrowser = () => {
          ws.data.queue = [];
          ws.data.queuedBytes = 0;
          if (!ws.data.opened) invalidateEndpoint(ws.data.computerId, ws.data.target);
          if (ws.readyState === WebSocket.OPEN) ws.close();
        };
        upstream.addEventListener("close", closeBrowser);
        upstream.addEventListener("error", closeBrowser);
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        const payload = frame(message);
        if (!upstream || upstream.readyState !== WebSocket.OPEN) {
          const size =
            typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
          if (
            ws.data.queue.length >= DESKTOP_WS_MAX_QUEUED_FRAMES ||
            ws.data.queuedBytes + size > DESKTOP_WS_MAX_QUEUED_BYTES
          ) {
            ws.data.queue = [];
            ws.data.queuedBytes = 0;
            ws.close(1008, "pre-open queue limit exceeded");
            ws.data.upstream?.close();
            return;
          }
          ws.data.queue.push(payload);
          ws.data.queuedBytes += size;
          return;
        }
        upstream.send(payload);
      },
      close(ws) {
        ws.data.queue = [];
        ws.data.queuedBytes = 0;
        ws.data.upstream?.close();
      },
    },
  });
  if (server.port === undefined) throw new Error("desktop proxy did not bind a port");
  console.log(`[desktop] listening on ${input.hostname}:${server.port}`);
  return {
    port: server.port,
    stop: () => {
      cache.clear();
      inflight.clear();
      server.stop(true);
    },
  };
}

async function proxyHttp(
  request: Request,
  target: DesktopEndpoint,
  upstreamPath: string,
  search: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of ["host", "connection", "transfer-encoding"]) {
    headers.delete(name);
  }
  headers.set("x-vnc-token", target.token);
  const params = new URLSearchParams(search);
  const title = params.get("title") ?? undefined;
  params.delete("title");
  const rest = params.toString();
  const buffered =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  if (buffered) headers.set("content-length", String(buffered.byteLength));
  else headers.delete("content-length");
  const upstream = await fetch(
    `http://${target.host}:${target.port}${upstreamPath}${rest.length > 0 ? `?${rest}` : ""}`,
    {
      method: request.method,
      headers,
      body: buffered,
      redirect: "manual",
    },
  );
  if (!upstreamPath.endsWith("/desktop.html") && upstreamPath !== "/desktop.html") return upstream;
  const html = withDesktopTitle(adaptDesktopHtml(await upstream.text()), title);
  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-length");
  return new Response(html, { status: upstream.status, headers: outHeaders });
}
