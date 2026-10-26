type ProxySocket = { path: string; protocol?: string; upstream?: WebSocket; pending: unknown[] };

/**
 * Same origin for a browser E2E's page and its realtime: the Web for pages and reads, Centrifugo
 * for `/connection/*`, as Caddy splits them in production. Shared by the browser E2Es that need
 * realtime; `stop` ends it.
 */
export function sameOriginProxy(
  upstreamOrigin: string,
  centrifugoOrigin: string,
  options: { afterUpstream?(url: URL): Promise<void> } = {},
) {
  const upstream = new URL(upstreamOrigin);
  const centrifugo = new URL(centrifugoOrigin);
  const server = Bun.serve<ProxySocket>({
    hostname: "127.0.0.1",
    port: 0,
    // A response gate owns its deadline and can deliberately hold a request idle.
    idleTimeout: options.afterUpstream ? 0 : undefined,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const upgraded = server.upgrade(request, {
          headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
          data: { path: url.pathname + url.search, protocol, pending: [] },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
      }
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set("origin", upstream.origin);
      forwardHeaders.delete("referer");
      const init: RequestInit & { duplex: "half" } = {
        method: request.method,
        headers: forwardHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        duplex: "half",
      };
      const response = await fetch(upstream.origin + url.pathname + url.search, init);
      if (options.afterUpstream) await options.afterUpstream(url);
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(response.body, { status: response.status, headers });
    },
    websocket: {
      open(client) {
        const target = client.data.path.startsWith("/connection/")
          ? `ws://${centrifugo.host}${client.data.path}`
          : `ws://${upstream.host}${client.data.path}`;
        // Sent without an Origin header, which Centrifugo's `allowed_origins` check lets through.
        const socket = new WebSocket(target, client.data.protocol);
        socket.binaryType = "arraybuffer";
        client.data.upstream = socket;
        socket.onopen = () => {
          for (const message of client.data.pending) socket.send(message as string);
          client.data.pending.length = 0;
        };
        socket.onmessage = (event) => client.send(event.data);
        socket.onclose = (event) => client.close(event.code, event.reason);
        socket.onerror = () => client.close(1011, "Upstream WebSocket error");
      },
      message(client, message) {
        const socket = client.data.upstream;
        if (socket?.readyState === WebSocket.OPEN) socket.send(message);
        else client.data.pending.push(message);
      },
      close(client) {
        client.data.upstream?.close();
      },
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
