import { serverFunctionNames, serverFunctionOf } from "./server-function-ids";

type ProxySocket = {
  path: string;
  protocol?: string;
  upstream?: WebSocket;
  pending: Array<string | Uint8Array<ArrayBuffer>>;
};

/**
 * Forwards to the local Web service at `upstreamOrigin`, holding the Server Functions `heldReads`
 * names (by id) while `hold()` is on. From `hold()`
 * on it also records each Server Function call, held or let through, and whether an answer let
 * through carries a watched message: what a failed assertion under the gate reports.
 */
const allServerFunctions = serverFunctionNames();

export function gatedProxy(upstreamOrigin: string, heldReads: ReadonlyMap<string, string>) {
  let gate: { release: () => void; opened: Promise<void> } | undefined;
  const heldNow = new Set<string>();
  let log: { start: number; lines: string[]; watched: string[] } | undefined;
  const note = (line: string) => log?.lines.push(`+${Date.now() - log.start}ms ${line}`);
  const upstream = new URL(upstreamOrigin);
  const server = Bun.serve<ProxySocket>({
    hostname: "127.0.0.1",
    port: 0,
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
      if (url.pathname === "/auth/logout" || url.pathname.endsWith("/auth/logout"))
        return new Response("signed out (stand-in for Authing)", { status: 200 });
      const name = serverFunctionOf(heldReads, url);
      const called = allServerFunctions.get(url.pathname.split("/_serverFn/")[1] ?? "");
      if (called) note(`-> ${called}${gate && name ? " (held)" : ""}`);
      if (gate && name) {
        const held = `${name} ${heldNow.size}`;
        heldNow.add(held);
        await gate.opened;
        heldNow.delete(held);
      }
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set("origin", upstream.origin);
      forwardHeaders.delete("referer");
      // A streamed request body needs `duplex` (Fetch standard), which this `RequestInit` type
      // does not declare yet.
      const init: RequestInit & { duplex: "half" } = {
        method: request.method,
        headers: forwardHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        duplex: "half",
      };
      const response = await fetch(upstream.origin + url.pathname + url.search, init);
      if (called && log) {
        const body = await response.clone().text();
        const carries = log.watched.filter((text) => body.includes(text));
        note(
          `<- ${called} ${response.status}${carries.length ? ` carries ${carries.join(", ")}` : ""}`,
        );
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      const location = headers.get("location");
      if (location)
        headers.set(
          "location",
          location.replace(upstream.origin, `http://127.0.0.1:${server.port}`),
        );
      return new Response(response.body, { status: response.status, headers });
    },
    websocket: {
      open(client) {
        const target = `ws://${upstream.host}${client.data.path}`;
        const socket = new WebSocket(target, client.data.protocol);
        socket.binaryType = "arraybuffer";
        client.data.upstream = socket;
        socket.onopen = () => {
          for (const message of client.data.pending) socket.send(message);
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
  return {
    origin: `http://127.0.0.1:${server.port}`,
    /** From now on the held reads wait for `release()`, and calls are recorded for `report()`,
     * noting an answer that carries one of `watched`. */
    hold(watched: string[] = []) {
      log = { start: Date.now(), lines: [], watched };
      let release: () => void = () => {};
      const opened = new Promise<void>((resolve) => (release = resolve));
      gate = { release, opened };
    },
    release() {
      gate?.release();
      gate = undefined;
    },
    /** How many held reads are waiting right now. */
    held: () => heldNow.size,
    /** Marks a point of the test in the record. */
    mark: (label: string) => note(`-- ${label}`),
    /** The record since the last `hold()`. */
    report: () => log?.lines.join("\n") ?? "(nothing recorded)",
    stop: () => server.stop(true),
  };
}
