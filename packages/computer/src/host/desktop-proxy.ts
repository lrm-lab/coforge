import { randomBytes } from "node:crypto";
import { adaptDesktopHtml, withDesktopTitle } from "./desktop-page";

export { adaptDesktopHtml, withDesktopTitle };

export type DesktopEndpoint = { host: string; port: number; token: string };

type SocketData = {
  upstream?: WebSocket;
  queue: Array<string | ArrayBuffer>;
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

/** noVNC files that share the computer desktop. An Agent id is anything else. */
const DESKTOP_ASSET = new Set(["websockify", "core", "vendor", "app", "desktop.html"]);

/**
 * `/desktop/<computer>/` is the computer's own screen.
 * `/desktop/<computer>/<agent>/` is that Agent's screen on the same computer.
 * The container serves the Agent page at `/screen/<agent>/`.
 */
export function parseDesktopRoute(
  pathname: string,
): { computerId: string; upstreamPath: string } | undefined {
  const match = /^\/desktop\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname.replace(/\/{2,}/g, "/"));
  if (!match?.[1]) return undefined;
  const computerId = match[1];
  const suffix = match[2] ?? "/";
  const parts = suffix.split("/").filter((part) => part.length > 0);
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

export function startDesktopProxy(input: {
  hostname: string;
  port: number;
  resolve: (computerId: string) => Promise<DesktopEndpoint | undefined>;
  handleRequest?: (request: Request) => Promise<Response | undefined>;
}): { port: number; stop: () => void } {
  const server = Bun.serve<SocketData>({
    hostname: input.hostname,
    port: input.port,
    async fetch(request, bun) {
      const handled = await input.handleRequest?.(request);
      if (handled) return handled;
      const url = new URL(request.url);
      const route = parseDesktopRoute(url.pathname);
      if (!route) return new Response("not found", { status: 404 });
      let target: DesktopEndpoint | undefined;
      try {
        target = await input.resolve(route.computerId);
      } catch {
        console.error("[desktop] lookup failed");
        return new Response("desktop lookup failed", { status: 502 });
      }
      if (!target) return new Response("desktop is not running", { status: 404 });
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = bun.upgrade(request, {
          data: { queue: [], target, upstreamPath: route.upstreamPath },
        });
        return upgraded ? undefined : new Response("websocket upgrade failed", { status: 400 });
      }
      return proxyHttp(request, target, route.upstreamPath, url.search);
    },
    websocket: {
      open(ws) {
        const { target, upstreamPath } = ws.data;
        const upstream = new WebSocket(
          `ws://${target.host}:${target.port}${upstreamPath}?token=${encodeURIComponent(target.token)}`,
        );
        ws.data.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        upstream.addEventListener("open", () => {
          for (const item of ws.data.queue) upstream.send(item);
          ws.data.queue = [];
        });
        upstream.addEventListener("message", (event) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(event.data);
        });
        const closeBrowser = () => {
          if (ws.readyState === WebSocket.OPEN) ws.close();
        };
        upstream.addEventListener("close", closeBrowser);
        upstream.addEventListener("error", closeBrowser);
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        const payload = frame(message);
        if (!upstream || upstream.readyState !== WebSocket.OPEN) {
          ws.data.queue.push(payload);
          return;
        }
        upstream.send(payload);
      },
      close(ws) {
        ws.data.upstream?.close();
      },
    },
  });
  if (server.port === undefined) throw new Error("desktop proxy did not bind a port");
  console.log(`[desktop] listening on ${input.hostname}:${server.port}`);
  return { port: server.port, stop: () => server.stop(true) };
}

async function proxyHttp(
  request: Request,
  target: DesktopEndpoint,
  upstreamPath: string,
  search: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of ["host", "connection", "content-length", "transfer-encoding"]) {
    headers.delete(name);
  }
  headers.set("x-vnc-token", target.token);
  const params = new URLSearchParams(search);
  const title = params.get("title") ?? undefined;
  params.delete("title");
  const rest = params.toString();
  const upstream = await fetch(
    `http://${target.host}:${target.port}${upstreamPath}${rest.length > 0 ? `?${rest}` : ""}`,
    {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    },
  );
  if (!upstreamPath.endsWith("/desktop.html") && upstreamPath !== "/desktop.html") return upstream;
  const html = withDesktopTitle(adaptDesktopHtml(await upstream.text()), title);
  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-length");
  return new Response(html, { status: upstream.status, headers: outHeaders });
}
