import { expect, spyOn, test } from "bun:test";
// The JSON build shares the protobuf build's dispatch code; its text frames keep this fake server
// readable.
import { Centrifuge } from "centrifuge";

import { decodeConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import {
  subscribeToSharedRealtime,
  type RealtimePublication,
  type SharedRealtimeClient,
} from "#src/features/realtime/browser-realtime";
import { fakeCentrifugoSocket } from "./helpers/fake-centrifugo-socket";

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("a handler that throws neither stops the channel's other handlers nor the client", async () => {
  // Before: the throw reached the client's dispatch chain, which then handled no frame again —
  // a page that looked connected and heard nothing until it reloaded (task #326).
  const centrifugo = fakeCentrifugoSocket();
  const client = new Centrifuge("ws://realtime.test/connection/websocket", {
    token: "connection-token",
    websocket: centrifugo.websocket,
  });
  // The pool is typed against the protobuf build; the JSON build's Subscription is the same code.
  const pool = client as unknown as SharedRealtimeClient;
  const heard: unknown[] = [];
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  const subscribed = Promise.withResolvers<void>();
  const stopThrowing = subscribeToSharedRealtime(pool, {
    channel: "chat:user:viewer",
    onSubscribed: () => subscribed.resolve(),
    onPublication: () => {
      throw new SyntaxError("not JSON");
    },
  });
  const stopHearing = subscribeToSharedRealtime(pool, {
    channel: "chat:user:viewer",
    onPublication: (publication: RealtimePublication) => heard.push(publication.data),
  });
  try {
    client.connect();
    await subscribed.promise;
    centrifugo.publish("chat:user:viewer", { n: 1 });
    await settle();
    centrifugo.publish("chat:user:viewer", { n: 2 });
    await settle();

    expect(heard).toEqual([{ n: 1 }, { n: 2 }]);
    expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
      "realtime handler failed on chat:user:viewer",
      "realtime handler failed on chat:user:viewer",
    ]);
  } finally {
    consoleError.mockRestore();
    stopThrowing();
    stopHearing();
    client.disconnect();
  }
});

test("a binary publication on the person's own channel is not a conversation activity", () => {
  // An Agent's reply intent in a direct conversation: protobuf, its request id a 36-byte UUID.
  const replyIntent = new Uint8Array([
    0x08,
    0x01,
    0x12,
    0x24,
    ...new TextEncoder().encode("fb694a2e-0000-4000-8000-000000000000"),
  ]);

  expect(decodeConversationActivityEvent(replyIntent)).toBeUndefined();
});
