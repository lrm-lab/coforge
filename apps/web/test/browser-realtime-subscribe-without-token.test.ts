import { expect, test } from "bun:test";
// The JSON build shares the protobuf build's Subscription code; its text frames keep this fake
// server readable.
import { Centrifuge } from "centrifuge";

import {
  subscribeToSharedRealtime,
  type SharedRealtimeClient,
} from "#src/features/realtime/browser-realtime";
import { fakeCentrifugoSocket } from "./helpers/fake-centrifugo-socket";

test("a shared subscription made while the connection opens is sent once, with no token", async () => {
  // Task #348: a page no longer fetches a subscription token per channel (one Server Function
  // request each; `SharedRealtimeOptions` has no way to pass one), and Centrifugo asks the
  // subscribe proxy instead. Every page subscription starts while the connection is opening.
  const { websocket, subscribeCommands } = fakeCentrifugoSocket();
  const client = new Centrifuge("ws://realtime.test/connection/websocket", {
    token: "connection-token",
    websocket,
  });
  const subscribed = Promise.withResolvers<void>();
  const release = subscribeToSharedRealtime(client as unknown as SharedRealtimeClient, {
    channel: "chat:conversation-a",
    onSubscribed: () => subscribed.resolve(),
  });
  try {
    client.connect();
    await subscribed.promise;
    // A second subscribe for the same channel would follow within a few frames.
    await Bun.sleep(100);

    expect(subscribeCommands.map((command) => [command.channel, command.token])).toEqual([
      ["chat:conversation-a", undefined],
    ]);
  } finally {
    release();
    client.disconnect();
  }
});
