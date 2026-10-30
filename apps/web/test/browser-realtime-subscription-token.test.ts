import { expect, test } from "bun:test";
// The JSON build shares the protobuf build's Subscription code; its text frames keep this fake
// server readable.
import { Centrifuge } from "centrifuge";

import { fakeCentrifugoSocket } from "./helpers/fake-centrifugo-socket";

test("a channel subscribed while the connection is opening asks for its subscription token once", async () => {
  // The Workspace layout hands its client to the page before the socket opens, so every page
  // subscription starts in this window. The token Server Function takes far longer than the
  // connect reply; release it only after the client has connected.
  const { websocket, subscribeCommands } = fakeCentrifugoSocket();
  const client = new Centrifuge("ws://realtime.test/connection/websocket", {
    token: "connection-token",
    websocket,
  });
  let tokenRequests = 0;
  const subscription = client.newSubscription("chat:conversation-a", {
    getToken: async () => {
      tokenRequests += 1;
      await client.ready();
      return "subscription-token";
    },
  });
  try {
    client.connect();
    subscription.subscribe();
    await subscription.ready();

    expect(tokenRequests).toBe(1);
    expect(subscribeCommands.map((command) => [command.channel, command.token])).toEqual([
      ["chat:conversation-a", "subscription-token"],
    ]);
  } finally {
    client.disconnect();
  }
});
