const utf8 = new TextDecoder();

export type CentrifugoClientCommand =
  | { kind: "subscribe"; id: number; channel: string }
  | { kind: "unsubscribe"; channel: string };

export type CentrifugoServerReply = { id: number; subscribed: boolean };

export type CentrifugoFrame = string | ArrayBuffer | ArrayBufferView;

type SocketTracker = {
  onClientFrame: (frame: CentrifugoFrame) => void;
  onServerFrame: (frame: CentrifugoFrame) => void;
  close: () => void;
};

type ProxySocket = {
  path: string;
  protocol?: string;
  upstream?: WebSocket;
  pending: unknown[];
  tracker?: SocketTracker;
};

function toBytes(frame: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
}

function readVarint(bytes: Uint8Array, pos: number, end: number): [number, number] | null {
  let value = 0;
  let factor = 1;
  let cursor = pos;
  while (cursor < end) {
    const byte = bytes[cursor++]!;
    value += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) return [value, cursor];
    factor *= 128;
    if (cursor - pos >= 10) return null;
  }
  return null;
}

function skipField(bytes: Uint8Array, pos: number, end: number, wireType: number): number {
  if (wireType === 0) {
    let cursor = pos;
    while (cursor < end) {
      if ((bytes[cursor++]! & 0x80) === 0) return cursor;
    }
    return end;
  }
  if (wireType === 1) return Math.min(end, pos + 8);
  if (wireType === 2) {
    const lenRes = readVarint(bytes, pos, end);
    if (!lenRes) return end;
    return Math.min(end, lenRes[1] + lenRes[0]);
  }
  if (wireType === 5) return Math.min(end, pos + 4);
  return end;
}

function readStringField1(bytes: Uint8Array, start: number, end: number): string | undefined {
  let pos = start;
  while (pos < end) {
    const tagRes = readVarint(bytes, pos, end);
    if (!tagRes) break;
    const [tag, afterTag] = tagRes;
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) {
      const lenRes = readVarint(bytes, afterTag, end);
      if (!lenRes) break;
      const [len, strStart] = lenRes;
      const strEnd = Math.min(end, strStart + len);
      return utf8.decode(bytes.subarray(strStart, strEnd));
    }
    pos = skipField(bytes, afterTag, end, wireType);
  }
  return undefined;
}

function forEachDelimitedMessage(bytes: Uint8Array, visit: (start: number, end: number) => void) {
  let pos = 0;
  while (pos < bytes.length) {
    const lenRes = readVarint(bytes, pos, bytes.length);
    if (!lenRes) break;
    const [len, msgStart] = lenRes;
    const msgEnd = msgStart + len;
    if (msgEnd > bytes.length) break;
    if (len > 0) visit(msgStart, msgEnd);
    pos = msgEnd;
  }
}

function parseJsonLines(frame: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        objects.push(parsed as Record<string, unknown>);
    } catch {
      // Ignore malformed JSON frames.
    }
  }
  return objects;
}

/** Extracts subscribe and unsubscribe commands from a client Centrifuge frame (protobuf or JSON). */
export function extractCentrifugoCommands(frame: CentrifugoFrame): CentrifugoClientCommand[] {
  if (typeof frame === "string") {
    const commands: CentrifugoClientCommand[] = [];
    for (const msg of parseJsonLines(frame)) {
      const id = typeof msg.id === "number" ? msg.id : undefined;
      const sub = msg.subscribe as { channel?: unknown } | undefined;
      if (id !== undefined && id > 0 && sub && typeof sub.channel === "string") {
        commands.push({ kind: "subscribe", id, channel: sub.channel });
        continue;
      }
      const unsub = msg.unsubscribe as { channel?: unknown } | undefined;
      if (unsub && typeof unsub.channel === "string")
        commands.push({ kind: "unsubscribe", channel: unsub.channel });
    }
    return commands;
  }

  const bytes = toBytes(frame);
  const commands: CentrifugoClientCommand[] = [];
  forEachDelimitedMessage(bytes, (start, end) => {
    let pos = start;
    let id: number | undefined;
    let subscribeChannel: string | undefined;
    let unsubscribeChannel: string | undefined;
    while (pos < end) {
      const tagRes = readVarint(bytes, pos, end);
      if (!tagRes) break;
      const [tag, afterTag] = tagRes;
      const field = tag >>> 3;
      const wireType = tag & 7;
      if (field === 1 && wireType === 0) {
        const valRes = readVarint(bytes, afterTag, end);
        if (!valRes) break;
        [id, pos] = valRes;
      } else if ((field === 5 || field === 6) && wireType === 2) {
        const lenRes = readVarint(bytes, afterTag, end);
        if (!lenRes) break;
        const subEnd = Math.min(end, lenRes[1] + lenRes[0]);
        const channel = readStringField1(bytes, lenRes[1], subEnd);
        if (channel !== undefined) {
          if (field === 5) subscribeChannel = channel;
          else unsubscribeChannel = channel;
        }
        pos = subEnd;
      } else {
        pos = skipField(bytes, afterTag, end, wireType);
      }
    }
    if (id !== undefined && id > 0 && subscribeChannel !== undefined)
      commands.push({ kind: "subscribe", id, channel: subscribeChannel });
    else if (unsubscribeChannel !== undefined)
      commands.push({ kind: "unsubscribe", channel: unsubscribeChannel });
  });
  return commands;
}

/** Extracts command reply acknowledgements from a server Centrifuge frame (protobuf or JSON). */
export function extractCentrifugoReplies(frame: CentrifugoFrame): CentrifugoServerReply[] {
  if (typeof frame === "string") {
    const replies: CentrifugoServerReply[] = [];
    for (const msg of parseJsonLines(frame)) {
      if (typeof msg.id === "number" && msg.id > 0) {
        replies.push({
          id: msg.id,
          subscribed: msg.subscribe !== undefined && !msg.error,
        });
      }
    }
    return replies;
  }

  const bytes = toBytes(frame);
  const replies: CentrifugoServerReply[] = [];
  forEachDelimitedMessage(bytes, (start, end) => {
    let pos = start;
    let id: number | undefined;
    let hasError = false;
    let hasSubscribe = false;
    while (pos < end) {
      const tagRes = readVarint(bytes, pos, end);
      if (!tagRes) break;
      const [tag, afterTag] = tagRes;
      const field = tag >>> 3;
      const wireType = tag & 7;
      if (field === 1 && wireType === 0) {
        const valRes = readVarint(bytes, afterTag, end);
        if (!valRes) break;
        [id, pos] = valRes;
      } else if (field === 2 && wireType === 2) {
        hasError = true;
        pos = skipField(bytes, afterTag, end, wireType);
      } else if (field === 6 && wireType === 2) {
        hasSubscribe = true;
        pos = skipField(bytes, afterTag, end, wireType);
      } else {
        pos = skipField(bytes, afterTag, end, wireType);
      }
    }
    if (id !== undefined && id > 0) replies.push({ id, subscribed: hasSubscribe && !hasError });
  });
  return replies;
}

/**
 * Tracks confirmed Centrifugo channel subscriptions across proxied WebSocket connections by
 * correlating client SubscribeRequest IDs with non-error server SubscribeResult replies.
 */
export function createCentrifugoSubscribeTracker() {
  const connections = new Set<{ pending: Map<number, string>; subscribed: Set<string> }>();
  const waiters = new Set<{ check: () => void; abort: (error: Error) => void }>();

  const notify = () => {
    for (const waiter of waiters) waiter.check();
  };

  function subscribedChannels(): Set<string> {
    const all = new Set<string>();
    for (const conn of connections) for (const channel of conn.subscribed) all.add(channel);
    return all;
  }

  function openSocket(): SocketTracker {
    const conn = { pending: new Map<number, string>(), subscribed: new Set<string>() };
    connections.add(conn);
    return {
      onClientFrame(frame) {
        let removed = false;
        for (const cmd of extractCentrifugoCommands(frame)) {
          if (cmd.kind === "subscribe") {
            conn.pending.set(cmd.id, cmd.channel);
          } else {
            if (conn.subscribed.delete(cmd.channel)) removed = true;
            for (const [id, channel] of conn.pending) {
              if (channel === cmd.channel) conn.pending.delete(id);
            }
          }
        }
        if (removed) notify();
      },
      onServerFrame(frame) {
        let changed = false;
        for (const reply of extractCentrifugoReplies(frame)) {
          const channel = conn.pending.get(reply.id);
          if (channel === undefined) continue;
          conn.pending.delete(reply.id);
          if (reply.subscribed && !conn.subscribed.has(channel)) {
            conn.subscribed.add(channel);
            changed = true;
          }
        }
        if (changed) notify();
      },
      close() {
        const hadSubscribed = conn.subscribed.size > 0;
        connections.delete(conn);
        conn.pending.clear();
        conn.subscribed.clear();
        if (hadSubscribed) notify();
      },
    };
  }

  function waitForSubscribed(channels: readonly string[], timeoutMs = 20_000): Promise<void> {
    const missing = () => {
      const current = subscribedChannels();
      return channels.filter((channel) => !current.has(channel));
    };
    if (missing().length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        const current = subscribedChannels();
        const stillMissing = channels.filter((channel) => !current.has(channel));
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for Centrifugo subscription ACK; missing=[${stillMissing.join(", ")}] subscribed=[${[...current].join(", ")}]`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
      };
      const waiter = {
        check() {
          if (missing().length === 0) {
            cleanup();
            resolve();
          }
        },
        abort(error: Error) {
          cleanup();
          reject(error);
        },
      };
      waiters.add(waiter);
    });
  }

  function dispose(reason = new Error("sameOriginProxy stopped before subscriptions settled")) {
    for (const waiter of waiters) waiter.abort(reason);
    connections.clear();
  }

  return { openSocket, subscribedChannels, waitForSubscribed, dispose };
}

/**
 * Same origin for a browser E2E's page and its realtime: the Web for pages and reads, Centrifugo
 * for `/connection/*`, as Caddy splits them in production. Shared by the browser E2Es that need
 * realtime; `stop` ends it.
 */
export function sameOriginProxy(
  upstreamOrigin: string,
  centrifugoOrigin: string,
  options: {
    afterUpstream?(url: URL): Promise<void>;
    /** Answers a request with a 503 instead of forwarding it, while this says so. */
    refuse?(url: URL): boolean;
  } = {},
) {
  const upstream = new URL(upstreamOrigin);
  const centrifugo = new URL(centrifugoOrigin);
  const tracker = createCentrifugoSubscribeTracker();
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
      if (options.refuse?.(url)) return new Response("Refused by the test", { status: 503 });
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
        const isRealtime = client.data.path.startsWith("/connection/");
        const target = isRealtime
          ? `ws://${centrifugo.host}${client.data.path}`
          : `ws://${upstream.host}${client.data.path}`;
        const socketTracker = isRealtime ? tracker.openSocket() : undefined;
        client.data.tracker = socketTracker;
        // Sent without an Origin header, which Centrifugo's `allowed_origins` check lets through.
        const socket = new WebSocket(target, client.data.protocol);
        socket.binaryType = "arraybuffer";
        client.data.upstream = socket;
        socket.onopen = () => {
          for (const message of client.data.pending) socket.send(message as string);
          client.data.pending.length = 0;
        };
        socket.onmessage = (event) => {
          client.send(event.data);
          if (
            socketTracker &&
            (typeof event.data === "string" ||
              event.data instanceof ArrayBuffer ||
              ArrayBuffer.isView(event.data))
          ) {
            socketTracker.onServerFrame(event.data);
          }
        };
        socket.onclose = (event) => client.close(event.code, event.reason);
        socket.onerror = () => client.close(1011, "Upstream WebSocket error");
      },
      message(client, message) {
        client.data.tracker?.onClientFrame(message);
        const socket = client.data.upstream;
        if (socket?.readyState === WebSocket.OPEN) socket.send(message);
        else client.data.pending.push(message);
      },
      close(client) {
        client.data.tracker?.close();
        client.data.upstream?.close();
      },
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => {
      tracker.dispose();
      server.stop(true);
    },
    subscribedChannels: tracker.subscribedChannels,
    waitForSubscribed: tracker.waitForSubscribed,
  };
}
