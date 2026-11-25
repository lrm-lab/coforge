import { expect, test } from "bun:test";
import { Centrifuge } from "centrifuge/build/protobuf";
import {
  createCentrifugoSubscribeTracker,
  extractCentrifugoCommands,
  extractCentrifugoReplies,
  sameOriginProxy,
} from "./helpers/same-origin-proxy";

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return bytes;
}

function encodeDelimited(parts: number[]): Uint8Array {
  return new Uint8Array([...encodeVarint(parts.length), ...parts]);
}

function encodeStringField(field: number, value: string): number[] {
  const encoded = [...new TextEncoder().encode(value)];
  return [(field << 3) | 2, ...encodeVarint(encoded.length), ...encoded];
}

function encodeSubMessage(field: number, payload: number[]): number[] {
  return [(field << 3) | 2, ...encodeVarint(payload.length), ...payload];
}

function protobufSubscribeCommand(id: number, channel: string): Uint8Array {
  return encodeDelimited([
    (1 << 3) | 0,
    ...encodeVarint(id),
    ...encodeSubMessage(5, encodeStringField(1, channel)),
  ]);
}

function protobufUnsubscribeCommand(id: number, channel: string): Uint8Array {
  return encodeDelimited([
    (1 << 3) | 0,
    ...encodeVarint(id),
    ...encodeSubMessage(6, encodeStringField(1, channel)),
  ]);
}

function protobufConnectCommand(id: number, token = ""): Uint8Array {
  return encodeDelimited([
    (1 << 3) | 0,
    ...encodeVarint(id),
    ...encodeSubMessage(4, token ? encodeStringField(1, token) : []),
  ]);
}

function protobufSubscribeReply(id: number, payload: number[] = []): Uint8Array {
  return encodeDelimited([(1 << 3) | 0, ...encodeVarint(id), ...encodeSubMessage(6, payload)]);
}

function protobufErrorReply(id: number, code: number, message: string): Uint8Array {
  return encodeDelimited([
    (1 << 3) | 0,
    ...encodeVarint(id),
    ...encodeSubMessage(2, [(1 << 3) | 0, ...encodeVarint(code), ...encodeStringField(2, message)]),
  ]);
}

function protobufConnectReply(id: number, clientId: string): Uint8Array {
  return encodeDelimited([
    (1 << 3) | 0,
    ...encodeVarint(id),
    ...encodeSubMessage(5, encodeStringField(1, clientId)),
  ]);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

test("extracts batched protobuf subscribe/unsubscribe commands and non-error replies (including empty SubscribeResult)", () => {
  const clientFrame = concatBytes([
    protobufConnectCommand(1, "tok"),
    protobufSubscribeCommand(2, "chat:channel-1"),
    protobufSubscribeCommand(3, "chat:workspace:ws-1"),
    protobufUnsubscribeCommand(4, "chat:old"),
  ]);
  expect(extractCentrifugoCommands(clientFrame)).toEqual([
    { kind: "subscribe", id: 2, channel: "chat:channel-1" },
    { kind: "subscribe", id: 3, channel: "chat:workspace:ws-1" },
    { kind: "unsubscribe", channel: "chat:old" },
  ]);

  const replyFrame = concatBytes([
    protobufConnectReply(1, "client-1"),
    protobufSubscribeReply(2, []),
    protobufSubscribeReply(3, [(1 << 3) | 0, 1]),
    protobufErrorReply(4, 403, "permission denied"),
  ]);
  expect(extractCentrifugoReplies(replyFrame)).toEqual([
    { id: 1, subscribed: false },
    { id: 2, subscribed: true },
    { id: 3, subscribed: true },
    { id: 4, subscribed: false },
  ]);
});

test("tracks confirmed subscriptions, rejects errored subscribes, and removes unsubscribed/closed sockets", async () => {
  const tracker = createCentrifugoSubscribeTracker();
  const socket = tracker.openSocket();

  socket.onClientFrame(
    concatBytes([
      protobufSubscribeCommand(10, "chat:ok"),
      protobufSubscribeCommand(11, "chat:denied"),
      protobufSubscribeCommand(12, "chat:pending"),
    ]),
  );
  expect([...tracker.subscribedChannels()]).toEqual([]);

  const waiting = tracker.waitForSubscribed(["chat:ok", "chat:pending"], 2_000);
  socket.onServerFrame(
    concatBytes([protobufSubscribeReply(10, []), protobufErrorReply(11, 403, "permission denied")]),
  );
  expect([...tracker.subscribedChannels()]).toEqual(["chat:ok"]);

  socket.onServerFrame(protobufSubscribeReply(12, [(3 << 3) | 0, 1]));
  await waiting;
  expect([...tracker.subscribedChannels()].sort()).toEqual(["chat:ok", "chat:pending"]);

  socket.onClientFrame(protobufUnsubscribeCommand(13, "chat:ok"));
  expect([...tracker.subscribedChannels()]).toEqual(["chat:pending"]);

  socket.close();
  expect([...tracker.subscribedChannels()]).toEqual([]);

  await expect(tracker.waitForSubscribed(["chat:missing"], 30)).rejects.toThrow(
    "missing=[chat:missing]",
  );
});

test("supports newline-delimited JSON Centrifuge frames", async () => {
  const tracker = createCentrifugoSubscribeTracker();
  const socket = tracker.openSocket();
  socket.onClientFrame(
    '{"id":1,"subscribe":{"channel":"chat:json-1"}}\n{"id":2,"subscribe":{"channel":"chat:json-err"}}\n',
  );
  socket.onServerFrame(
    '{"id":1,"subscribe":{}}\n{"id":2,"error":{"code":403,"message":"denied"}}\n',
  );
  expect([...tracker.subscribedChannels()]).toEqual(["chat:json-1"]);
  await tracker.waitForSubscribed(["chat:json-1"], 200);
  socket.onClientFrame('{"id":3,"unsubscribe":{"channel":"chat:json-1"}}\n');
  expect([...tracker.subscribedChannels()]).toEqual([]);
});

test("sameOriginProxy observes real Centrifuge protobuf subscribe handshakes end to end", async () => {
  const web = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  const centrifugo = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
      if (
        server.upgrade(request, {
          headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
        })
      )
        return;
      return new Response("Expected WS", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const bytes =
          typeof message === "string"
            ? new Uint8Array()
            : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
        for (const cmd of extractCentrifugoCommands(bytes)) {
          if (cmd.kind === "subscribe") {
            ws.send(
              cmd.channel === "chat:forbidden"
                ? protobufErrorReply(cmd.id, 403, "permission denied")
                : protobufSubscribeReply(cmd.id, []),
            );
          }
        }
        // Connect command arrives with id 1; decode id=1 from protobuf frames lacking subscribe/unsubscribe.
        if (bytes.length > 0 && extractCentrifugoCommands(bytes).length === 0) {
          ws.send(protobufConnectReply(1, "stub-client"));
        }
      },
    },
  });

  const proxy = sameOriginProxy(web.url.origin, centrifugo.url.origin);
  const client = new Centrifuge(`ws://${new URL(proxy.origin).host}/connection/websocket`, {
    token: "test-token",
  });
  try {
    const okSub = client.newSubscription("chat:allowed");
    const deniedSub = client.newSubscription("chat:forbidden");
    okSub.subscribe();
    deniedSub.subscribe();
    client.connect();

    await proxy.waitForSubscribed(["chat:allowed"], 5_000);
    expect([...proxy.subscribedChannels()]).toEqual(["chat:allowed"]);
  } finally {
    client.disconnect();
    proxy.stop();
    centrifugo.stop(true);
    web.stop(true);
  }
});
