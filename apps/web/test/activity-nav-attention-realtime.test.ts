import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  activityNavAttentionQuery,
  activityNavAttentionRealtime,
} from "#src/features/inbox/activity-inbox-queries";
import type { ActivityUnreadMessage } from "#src/features/inbox/activity-unread-count";
import type { StreamPosition } from "#src/features/realtime/subscription-gap";
import { dataBecomes, gatedRead, settle } from "./helpers/query-cache-harness";

type Dot = {
  hasUnread: boolean;
  streamPositions: Record<string, StreamPosition>;
  unreadCount?: number;
  unreadKeys?: string[];
};
const USER = "user-1";
const WS = "ws-1";
const CHANNEL = `chat:user:${USER}`;
const at = (offset: number) => ({ [CHANNEL]: { epoch: "e", offset } });
/** A message from another person, as the page hears it. */
const aMessage = (
  fields: Partial<ActivityUnreadMessage & { workspaceId: string }> = {},
): ActivityUnreadMessage & { workspaceId: string } => ({
  workspaceId: WS,
  conversationId: "channel-1",
  senderUserId: "ada",
  sender: { kind: "user", name: "Ada" },
  ...fields,
});

/**
 * Task #289: the nav Activity dot cleared only in the tab that marked the inbox read. Its realtime
 * handler set `{ hasUnread: true }` for every signal, so the `activity.changed.v1` another tab's
 * Done or read-all announces could never un-light this tab's dot. `onActivity` now re-reads the
 * boolean; `onMessage` still lights it locally because a message can only add attention.
 */
function mountedDot(queryClient: QueryClient, read: () => Promise<Dot>) {
  const queryKey = activityNavAttentionQuery(WS).queryKey;
  const observer = new QueryObserver(queryClient, {
    ...activityNavAttentionQuery(WS),
    queryFn: read,
  });
  const unsubscribe = observer.subscribe(() => {});
  return {
    queryKey,
    unsubscribe,
    data: () => queryClient.getQueryData<Dot>(queryKey),
  };
}

test("a message lights the nav dot without reading the server", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  const read = async () => {
    reads++;
    return { hasUnread: false, streamPositions: at(4) };
  };
  // Fresh data keeps the mount below from fetching (staleTime is 30 s).
  queryClient.setQueryData(activityNavAttentionQuery(WS).queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  const dot = mountedDot(queryClient, read);
  try {
    const { onMessage } = activityNavAttentionRealtime(queryClient, USER, WS);
    onMessage(aMessage(), { epoch: "e", offset: 5 });
    expect(dot.data()).toEqual({ hasUnread: true, streamPositions: at(4) });
    expect(reads).toBe(0);
  } finally {
    dot.unsubscribe();
  }
});

test("a message in a conversation the viewer muted leaves the nav dot dark (task #478)", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(activityNavAttentionQuery(WS).queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  const { onMessage } = activityNavAttentionRealtime(queryClient, USER, WS);
  onMessage(aMessage({ muted: true }), { epoch: "e", offset: 5 });
  expect(queryClient.getQueryData<Dot>(activityNavAttentionQuery(WS).queryKey)).toEqual({
    hasUnread: false,
    streamPositions: at(4),
  });
});

test("an activity change re-reads the dot, so another tab's read-all un-lights this one", async () => {
  const queryClient = new QueryClient();
  const dot = mountedDot(queryClient, async () => ({ hasUnread: false, streamPositions: {} }));
  try {
    // The dot is lit and fresh: nothing refetches it on its own (staleTime is 30 s).
    queryClient.setQueryData(dot.queryKey, { hasUnread: true, streamPositions: {} });
    const { onActivity } = activityNavAttentionRealtime(queryClient, USER, WS);
    onActivity();
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => d.hasUnread === false);
    expect(dot.data()).toEqual({ hasUnread: false, streamPositions: {} });
  } finally {
    dot.unsubscribe();
  }
});

/**
 * Task #348 (the #289 follow-up): another tab's Done, read-all or mark-unread reached this one's
 * dot only after a 300 ms debounce and a read of its own. The write now announces where the inbox
 * stands (`ActivityAttention`), and the dot takes it at once without reading.
 */
const after = (offset: number) => ({ epoch: "e", offset });

function litDot(queryClient: QueryClient, read: () => Promise<Dot>) {
  // Lit and fresh: nothing refetches it on its own (staleTime is 30 s).
  queryClient.setQueryData(activityNavAttentionQuery(WS).queryKey, {
    hasUnread: true,
    streamPositions: at(4),
  });
  return mountedDot(queryClient, read);
}

test("another tab's read-all clears the dot from the announcement, without a read", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  const dot = litDot(queryClient, async () => {
    reads++;
    return { hasUnread: true, streamPositions: at(4) };
  });
  try {
    activityNavAttentionRealtime(queryClient, USER, WS).onAttention(
      {
        hasUnread: false,
        streamPosition: after(6),
      },
      WS,
    );
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => !d.hasUnread);
    expect(dot.data()).toEqual({ hasUnread: false, streamPositions: at(6) });
    expect(reads).toBe(0);
  } finally {
    dot.unsubscribe();
  }
});

test("another tab's mark-unread lights the dot from the announcement", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(activityNavAttentionQuery(WS).queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  const dot = mountedDot(queryClient, async () => ({ hasUnread: false, streamPositions: at(4) }));
  try {
    activityNavAttentionRealtime(queryClient, USER, WS).onAttention(
      {
        hasUnread: true,
        streamPosition: after(6),
      },
      WS,
    );
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => d.hasUnread);
  } finally {
    dot.unsubscribe();
  }
});

test("a message published after the server's read keeps the dot lit; one before it does not", async () => {
  const queryClient = new QueryClient();
  const dot = litDot(queryClient, async () => ({ hasUnread: true, streamPositions: at(4) }));
  try {
    const { onMessage, onAttention } = activityNavAttentionRealtime(queryClient, USER, WS);
    // Message 7 reached this page before the announcement of a read made at 6, which may lack it.
    onMessage(aMessage(), after(7));
    onAttention({ hasUnread: false, streamPosition: after(6) }, WS);
    await settle();
    expect(dot.data()?.hasUnread).toBe(true);
    // A later read-all, made at 8, saw message 7.
    onAttention({ hasUnread: false, streamPosition: after(8) }, WS);
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => !d.hasUnread);
  } finally {
    dot.unsubscribe();
  }
});

test("a message published right after the announcement lights the dot again", async () => {
  const queryClient = new QueryClient();
  const dot = litDot(queryClient, async () => ({ hasUnread: true, streamPositions: at(4) }));
  try {
    const { onMessage, onAttention } = activityNavAttentionRealtime(queryClient, USER, WS);
    // Both in one frame: the read-all made at 6, then message 7.
    onAttention({ hasUnread: false, streamPosition: after(6) }, WS);
    onMessage(aMessage(), after(7));
    await settle();
    expect(dot.data()?.hasUnread).toBe(true);
  } finally {
    dot.unsubscribe();
  }
});

test("a lit dot reads again when the server's place cannot be compared with its message", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  const dot = litDot(queryClient, async () => {
    reads++;
    return { hasUnread: false, streamPositions: at(9) };
  });
  try {
    const { onMessage, onAttention } = activityNavAttentionRealtime(queryClient, USER, WS);
    onMessage(aMessage(), after(7));
    // Centrifugo did not answer the write's position read in time.
    onAttention({ hasUnread: false }, WS);
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => !d.hasUnread);
    expect(reads).toBe(1);
    // The read answered for the message; the next announcement needs no read.
    onMessage(aMessage(), after(10));
    onAttention({ hasUnread: false, streamPosition: after(11) }, WS);
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => !d.hasUnread);
    expect(reads).toBe(1);
  } finally {
    dot.unsubscribe();
  }
});

test("a read from further along the channel than the announcement replaces it", async () => {
  const queryClient = new QueryClient();
  const gate = gatedRead<Dot>();
  const dot = litDot(queryClient, gate.read);
  try {
    const { onActivity, onAttention } = activityNavAttentionRealtime(queryClient, USER, WS);
    onAttention({ hasUnread: false, streamPosition: after(6) }, WS);
    // A resubscribe's read, which saw message 8 the subscription missed.
    onActivity();
    await gate.started;
    gate.release({ hasUnread: true, streamPositions: at(8) });
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => d.hasUnread);
    expect(dot.data()).toEqual({ hasUnread: true, streamPositions: at(8) });
  } finally {
    dot.unsubscribe();
  }
});

test("a read under way when the announcement arrives does not bring the dot back", async () => {
  const queryClient = new QueryClient();
  const gate = gatedRead<Dot>();
  const dot = litDot(queryClient, gate.read);
  try {
    const { onActivity, onAttention } = activityNavAttentionRealtime(queryClient, USER, WS);
    // A mention from outside the channel started a read; the read-all is announced meanwhile.
    onActivity();
    await gate.started;
    onAttention({ hasUnread: false, streamPosition: after(6) }, WS);
    gate.release({ hasUnread: true, streamPositions: at(5) });
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => !d.hasUnread);
    await settle();
    expect(dot.data()).toEqual({ hasUnread: false, streamPositions: at(6) });
  } finally {
    dot.unsubscribe();
  }
});

/**
 * Task #348: a mention published after the page read the dot but before its own channel's
 * subscription started never reached the page, which read the dot only at load. The subscribe now
 * compares where the dot was read with where the stream stands for the subscription.
 */
test("a mention published between the dot's read and the subscribe lights it", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  queryClient.setQueryData(activityNavAttentionQuery(WS).queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  const dot = mountedDot(queryClient, async () => {
    reads++;
    return { hasUnread: true, streamPositions: at(5) };
  });
  try {
    // The mention is publication 5; the subscription starts after it.
    activityNavAttentionRealtime(queryClient, USER, WS).onSubscribed({
      wasRecovering: false,
      recovered: false,
      position: () => ({ epoch: "e", offset: 5 }),
    });
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => d.hasUnread);
    expect(reads).toBe(1);
  } finally {
    dot.unsubscribe();
  }
});

test("a subscribe that missed nothing reads nothing; one that lost publications reads", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  queryClient.setQueryData(activityNavAttentionQuery(WS).queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  const dot = mountedDot(queryClient, async () => {
    reads++;
    return { hasUnread: false, streamPositions: at(4) };
  });
  try {
    const { onSubscribed } = activityNavAttentionRealtime(queryClient, USER, WS);
    onSubscribed({
      wasRecovering: false,
      recovered: false,
      position: () => ({ epoch: "e", offset: 4 }),
    });
    onSubscribed({ wasRecovering: true, recovered: true });
    await Bun.sleep(20);
    expect(reads).toBe(0);
    onSubscribed({ wasRecovering: true, recovered: false });
    await dataBecomes<Dot>(queryClient, dot.queryKey, () => reads === 1);
    expect(reads).toBe(1);
  } finally {
    dot.unsubscribe();
  }
});

/**
 * Task #62: the nav badge's number. A server that counts sends `unreadCount` and `unreadKeys` with
 * the dot; a message adds its item to them without a read, and an announcement replaces them.
 */
function countingDot(queryClient: QueryClient, read: () => Promise<Dot>, held: Partial<Dot> = {}) {
  queryClient.setQueryData(activityNavAttentionQuery(WS).queryKey, {
    hasUnread: false,
    unreadCount: 0,
    unreadKeys: [],
    streamPositions: at(4),
    ...held,
  });
  return mountedDot(queryClient, read);
}

test("a message adds its conversation to the count, and a second one in it does not", () => {
  const queryClient = new QueryClient();
  const dot = countingDot(queryClient, async () => ({ hasUnread: false, streamPositions: at(4) }));
  try {
    const { onMessage } = activityNavAttentionRealtime(queryClient, USER, WS);
    onMessage(aMessage(), after(5));
    onMessage(aMessage({ threadRootId: "root-1" }), after(6));
    onMessage(aMessage(), after(7));
    expect(dot.data()).toEqual({
      hasUnread: true,
      unreadCount: 2,
      unreadKeys: ["conversation:channel-1", "thread:root-1"],
      streamPositions: at(4),
    });
  } finally {
    dot.unsubscribe();
  }
});

test("a message from a server that sends no count lights the dot alone", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(activityNavAttentionQuery(WS).queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  activityNavAttentionRealtime(queryClient, USER, WS).onMessage(aMessage(), after(5));
  expect(queryClient.getQueryData<Dot>(activityNavAttentionQuery(WS).queryKey)).toEqual({
    hasUnread: true,
    streamPositions: at(4),
  });
});

test("an announcement replaces the count and its keys, and drops them from a server that sends none", async () => {
  const queryClient = new QueryClient();
  const dot = countingDot(queryClient, async () => ({ hasUnread: true, streamPositions: at(4) }), {
    hasUnread: true,
    unreadCount: 3,
    unreadKeys: ["conversation:a", "conversation:b", "conversation:c"],
  });
  try {
    const { onAttention } = activityNavAttentionRealtime(queryClient, USER, WS);
    onAttention(
      {
        hasUnread: true,
        streamPosition: after(6),
        unreadCount: 1,
        unreadKeys: ["conversation:c"],
      },
      WS,
    );
    expect(dot.data()).toEqual({
      hasUnread: true,
      unreadCount: 1,
      unreadKeys: ["conversation:c"],
      streamPositions: at(6),
    });
    onAttention({ hasUnread: false, streamPosition: after(8) }, WS);
    expect(dot.data()).toEqual({ hasUnread: false, streamPositions: at(8) });
  } finally {
    dot.unsubscribe();
  }
});

test("a count announced from before a message that reached this page reads again", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  const dot = countingDot(queryClient, async () => {
    reads++;
    return { hasUnread: true, unreadCount: 2, unreadKeys: ["a", "b"], streamPositions: at(9) };
  });
  try {
    const { onMessage, onAttention } = activityNavAttentionRealtime(queryClient, USER, WS);
    onMessage(aMessage(), after(7));
    // The announcement was read at 6, before message 7: its count may lack it.
    onAttention(
      { hasUnread: true, streamPosition: after(6), unreadCount: 1, unreadKeys: ["a"] },
      WS,
    );
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => d.unreadCount === 2);
    expect(reads).toBe(1);
  } finally {
    dot.unsubscribe();
  }
});

test("a muted conversation's message leaves the count and reads the server, at most once per interval", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  const dot = countingDot(queryClient, async () => {
    reads++;
    return { hasUnread: true, unreadCount: reads, unreadKeys: [], streamPositions: at(4) };
  });
  try {
    const { onMessage } = activityNavAttentionRealtime(queryClient, USER, WS, {
      rereadIntervalMs: 20,
    });
    // A burst: the first reads at once, the rest wait for one read at the end of the interval.
    onMessage(aMessage({ muted: true }), after(5));
    onMessage(aMessage({ muted: true }), after(6));
    onMessage(aMessage({ muted: true }), after(7));
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => d.unreadCount === 1);
    expect(reads).toBe(1);
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => d.unreadCount === 2);
    expect(reads).toBe(2);
  } finally {
    dot.unsubscribe();
  }
});

test("another Workspace's message and announcement leave this Workspace's count alone", () => {
  const queryClient = new QueryClient();
  const held = { hasUnread: true, unreadCount: 2, unreadKeys: ["a", "b"], streamPositions: at(4) };
  queryClient.setQueryData(activityNavAttentionQuery(WS).queryKey, held);
  const { onMessage, onAttention } = activityNavAttentionRealtime(queryClient, USER, WS);
  onMessage(aMessage({ workspaceId: "ws-2" }), after(5));
  onAttention(
    { hasUnread: false, unreadCount: 0, unreadKeys: [], streamPosition: after(6) },
    "ws-2",
  );
  expect(queryClient.getQueryData(activityNavAttentionQuery(WS).queryKey)).toEqual(held);
});

test("a clearing announcement read before a message that reached this page reads the count again", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  const dot = countingDot(queryClient, async () => {
    reads++;
    return {
      hasUnread: true,
      unreadCount: 1,
      unreadKeys: ["conversation:channel-1"],
      streamPositions: at(9),
    };
  });
  try {
    const { onMessage, onAttention } = activityNavAttentionRealtime(queryClient, USER, WS);
    onMessage(aMessage(), after(7));
    // A read-all made at 6 cleared everything but message 7, which the count still holds with the old items.
    onAttention({ hasUnread: false, unreadCount: 0, unreadKeys: [], streamPosition: after(6) }, WS);
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => d.unreadCount === 1);
    expect(reads).toBe(1);
  } finally {
    dot.unsubscribe();
  }
});
