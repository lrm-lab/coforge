import { expect, test } from "bun:test";

import {
  subscribeToSharedRealtime,
  type SharedRealtimeClient,
} from "#src/features/realtime/browser-realtime";
import type { SubscribedRecovery } from "#src/features/realtime/subscription-gap";

/** An offset as the protobuf client hands it over: a `Long`, which has no `valueOf`, so two of
 * them compare by their decimal strings. */
const long = (offset: number) => ({
  low: offset,
  high: 0,
  unsigned: true,
  toString: () => String(offset),
});

test("a channel's stream position moves past offsets of more digits", () => {
  // Before: offsets kept as `Long`s compared as strings, so "100" was not past "99" and the
  // position stayed behind publications already delivered. A conversation pane joining the
  // subscription then took a window read at 100 for one that had missed nothing (task #358).
  const handlers = new Map<string, (event: unknown) => void>();
  const subscription = {
    state: "unsubscribed",
    on: (event: string, handler: (event: unknown) => void) => handlers.set(event, handler),
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  };
  const client = {
    newSubscription: () => subscription,
    removeSubscription: () => undefined,
  } as unknown as SharedRealtimeClient;
  const release = subscribeToSharedRealtime(client, { channel: "chat:conversation" });
  try {
    handlers.get("subscribed")!({
      wasRecovering: false,
      recovered: false,
      streamPosition: { epoch: "epoch", offset: long(98) },
    });
    for (const offset of [99, 100, 101])
      handlers.get("publication")!({
        channel: "chat:conversation",
        data: {},
        offset: long(offset),
      });
    subscription.state = "subscribed";

    let joined: SubscribedRecovery | undefined;
    const leave = subscribeToSharedRealtime(client, {
      channel: "chat:conversation",
      onSubscribed: (recovery) => (joined = recovery),
    });
    expect(joined?.position?.()).toEqual({ epoch: "epoch", offset: 101 });
    leave();
  } finally {
    release();
  }
});
