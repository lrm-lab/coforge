import { randomBytes } from "node:crypto";

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

export function parseDesktopRoute(
  pathname: string,
): { computerId: string; upstreamPath: string } | undefined {
  const match = /^\/desktop\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname.replace(/\/{2,}/g, "/"));
  if (!match?.[1]) return undefined;
  const suffix = match[2] ?? "/";
  return {
    computerId: match[1],
    upstreamPath: suffix === "/" ? "/desktop.html" : suffix,
  };
}

const RELATIVE_PAGE_SCRIPT = `
    import RFB from "./core/rfb.js";

    const msg = document.getElementById("msg");
    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = location.pathname.replace(/\\/desktop\\.html$/, "").replace(/\\/+$/, "");
    const query = token ? \`?token=\${encodeURIComponent(token)}\` : "";
    const url = \`\${proto}://\${location.host}\${base}/websockify\${query}\`;
    const rfb = new RFB(document.getElementById("screen"), url);
    rfb.scaleViewport = true;
    rfb.focusOnClick = true;
    rfb.addEventListener("connect", () => msg.remove());
    rfb.addEventListener("securityfailure", (ev) => {
      msg.textContent = ev.detail?.reason || "桌面连接失败";
    });
    rfb.addEventListener("disconnect", (ev) => {
      if (!ev.detail?.clean && document.body.contains(msg)) {
        msg.textContent = "桌面连接已断开";
      }
    });
`;

/** Older images require a token in the address and load noVNC from the site root. */
export function adaptDesktopHtml(html: string): string {
  if (!html.includes('from "/core/rfb.js"') && !html.includes("缺少连接令牌")) return html;
  return html.replace(
    /<script type="module">[\s\S]*?<\/script>/,
    `<script type="module">${RELATIVE_PAGE_SCRIPT}  </script>`,
  );
}

export function startDesktopProxy(input: {
  hostname: string;
  port: number;
  resolve: (computerId: string) => Promise<DesktopEndpoint | undefined>;
}): { port: number; stop: () => void } {
  const server = Bun.serve<SocketData>({
    hostname: input.hostname,
    port: input.port,
    async fetch(request, bun) {
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
  const upstream = await fetch(`http://${target.host}:${target.port}${upstreamPath}${search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  if (!upstreamPath.endsWith("/desktop.html") && upstreamPath !== "/desktop.html") return upstream;
  const html = adaptDesktopHtml(await upstream.text());
  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-length");
  return new Response(html, { status: upstream.status, headers: outHeaders });
}
