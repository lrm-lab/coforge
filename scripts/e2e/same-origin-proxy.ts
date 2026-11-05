type ProxySocketData = {
  path: string;
  protocol?: string;
  upstream?: WebSocket;
  pending: Array<string | Uint8Array<ArrayBuffer>>;
};

// One origin for a browser e2e page, as the managed stack and production have: the Web client
// opens `${location.host}/connection/websocket`, which goes to Centrifugo, and everything else to
// the Web. The defaults are the managed stack's (`.amp/services.yaml`); the CI runner
// (`run-web-e2e-ci.sh`) sets its own ports.
const webOrigin = Bun.env.E2E_PROXY_WEB_ORIGIN ?? "http://127.0.0.1:8789";
const centrifugoOrigin = Bun.env.E2E_PROXY_CENTRIFUGO_ORIGIN ?? "ws://127.0.0.1:8000";
const port = Number(Bun.env.E2E_PROXY_PORT ?? 8790);
// Loopback by default: the Web behind it skips sign-in, so it must not answer the LAN. The .amp
// e2e-proxy service sets E2E_PROXY_HOST=0.0.0.0 because its portal reaches the orb from off it.
const hostname = Bun.env.E2E_PROXY_HOST ?? "127.0.0.1";

export async function forwardWebRequest(request: Request, origin: string) {
  const url = new URL(request.url);
  try {
    const response = await fetch(new Request(origin + url.pathname + url.search, request), {
      redirect: "manual",
    });
    // Bun's fetch has already decoded a compressed body; passed on with its Content-Encoding, the
    // browser decodes it again and fails (an attachment's text preview never opened, task #438).
    if (!response.headers.has("content-encoding")) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return new Response("Web application is starting", { status: 503 });
  }
}

if (import.meta.main) {
  Bun.serve<ProxySocketData>({
    hostname,
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/connection/")) {
        const protocol = request.headers
          .get("sec-websocket-protocol")
          ?.split(",")
          .map((value) => value.trim())
          .find((value) => value === "centrifuge-protobuf");
        if (
          server.upgrade(request, {
            headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
            data: { path: url.pathname + url.search, protocol, pending: [] },
          })
        )
          return;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      return forwardWebRequest(request, webOrigin);
    },
    websocket: {
      open(client) {
        const upstream = new WebSocket(centrifugoOrigin + client.data.path, client.data.protocol);
        upstream.binaryType = "arraybuffer";
        client.data.upstream = upstream;
        upstream.onopen = () => {
          for (const message of client.data.pending) upstream.send(message);
          client.data.pending.length = 0;
        };
        upstream.onmessage = (event) => client.send(event.data);
        upstream.onclose = (event) => client.close(event.code, event.reason);
        upstream.onerror = () => client.close(1011, "Upstream WebSocket error");
      },
      message(client, message) {
        const upstream = client.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
        else client.data.pending.push(message);
      },
      close(client) {
        client.data.upstream?.close();
      },
    },
  });

  console.log(`E2E same-origin WebSocket proxy listening on ${port}`);
}
