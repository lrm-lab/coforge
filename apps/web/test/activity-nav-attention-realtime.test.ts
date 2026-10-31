import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  activityNavAttentionQuery,
  activityNavAttentionRealtime,
} from "#src/features/inbox/activity-inbox-queries";
import type { StreamPosition } from "#src/features/realtime/subscription-gap";
import { dataBecomes, gatedRead, settle } from "./helpers/query-cache-harness";

type Dot = { hasUnread: boolean; streamPositions: Record<string, StreamPosition> };
const USER = "user-1";
const CHANNEL = `chat:user:${USER}`;
const at = (offset: number) => ({ [CHANNEL]: { epoch: "e", offset } });

/**
 * Task #289: the nav Activity dot cleared only in the tab that marked the inbox read. Its realtime
 * handler set `{ hasUnread: true }` for every signal, so the `activity.changed.v1` another tab's
 * Done or read-all announces could never un-light this tab's dot. `onActivity` now re-reads the
 * boolean; `onMessage` still lights it locally because a message can only add attention.
 */
function mountedDot(queryClient: QueryClient, read: () => Promise<Dot>) {
  const queryKey = activityNavAttentionQuery().queryKey;
  const observer = new QueryObserver(queryClient, {
    ...activityNavAttentionQuery(),
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
  queryClient.setQueryData(activityNavAttentionQuery().queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  const dot = mountedDot(queryClient, read);
  try {
    const { onMessage } = activityNavAttentionRealtime(queryClient, USER);
    onMessage(undefined, { epoch: "e", offset: 5 });
    expect(dot.data()).toEqual({ hasUnread: true, streamPositions: at(4) });
    expect(reads).toBe(0);
  } finally {
    dot.unsubscribe();
  }
});

test("an activity change re-reads the dot, so another tab's read-all un-lights this one", async () => {
  const queryClient = new QueryClient();
  const dot = mountedDot(queryClient, async () => ({ hasUnread: false, streamPositions: {} }));
  try {
    // The dot is lit and fresh: nothing refetches it on its own (staleTime is 30 s).
    queryClient.setQueryData(dot.queryKey, { hasUnread: true, streamPositions: {} });
    const { onActivity } = activityNavAttentionRealtime(queryClient, USER);
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
  queryClient.setQueryData(activityNavAttentionQuery().queryKey, {
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
    activityNavAttentionRealtime(queryClient, USER).onAttention({
      hasUnread: false,
      streamPosition: after(6),
    });
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => !d.hasUnread);
    expect(dot.data()).toEqual({ hasUnread: false, streamPositions: at(6) });
    expect(reads).toBe(0);
  } finally {
    dot.unsubscribe();
  }
});

test("another tab's mark-unread lights the dot from the announcement", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(activityNavAttentionQuery().queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  const dot = mountedDot(queryClient, async () => ({ hasUnread: false, streamPositions: at(4) }));
  try {
    activityNavAttentionRealtime(queryClient, USER).onAttention({
      hasUnread: true,
      streamPosition: after(6),
    });
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => d.hasUnread);
  } finally {
    dot.unsubscribe();
  }
});

test("a message published after the server's read keeps the dot lit; one before it does not", async () => {
  const queryClient = new QueryClient();
  const dot = litDot(queryClient, async () => ({ hasUnread: true, streamPositions: at(4) }));
  try {
    const { onMessage, onAttention } = activityNavAttentionRealtime(queryClient, USER);
    // Message 7 reached this page before the announcement of a read made at 6, which may lack it.
    onMessage(undefined, after(7));
    onAttention({ hasUnread: false, streamPosition: after(6) });
    await settle();
    expect(dot.data()?.hasUnread).toBe(true);
    // A later read-all, made at 8, saw message 7.
    onAttention({ hasUnread: false, streamPosition: after(8) });
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => !d.hasUnread);
  } finally {
    dot.unsubscribe();
  }
});

test("a message published right after the announcement lights the dot again", async () => {
  const queryClient = new QueryClient();
  const dot = litDot(queryClient, async () => ({ hasUnread: true, streamPositions: at(4) }));
  try {
    const { onMessage, onAttention } = activityNavAttentionRealtime(queryClient, USER);
    // Both in one frame: the read-all made at 6, then message 7.
    onAttention({ hasUnread: false, streamPosition: after(6) });
    onMessage(undefined, after(7));
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
    const { onMessage, onAttention } = activityNavAttentionRealtime(queryClient, USER);
    onMessage(undefined, after(7));
    // Centrifugo did not answer the write's position read in time.
    onAttention({ hasUnread: false });
    await dataBecomes<Dot>(queryClient, dot.queryKey, (d) => !d.hasUnread);
    expect(reads).toBe(1);
    // The read answered for the message; the next announcement needs no read.
    onMessage(undefined, after(10));
    onAttention({ hasUnread: false, streamPosition: after(11) });
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
    const { onActivity, onAttention } = activityNavAttentionRealtime(queryClient, USER);
    onAttention({ hasUnread: false, streamPosition: after(6) });
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
    const { onActivity, onAttention } = activityNavAttentionRealtime(queryClient, USER);
    // A mention from outside the channel started a read; the read-all is announced meanwhile.
    onActivity();
    await gate.started;
    onAttention({ hasUnread: false, streamPosition: after(6) });
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
  queryClient.setQueryData(activityNavAttentionQuery().queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  const dot = mountedDot(queryClient, async () => {
    reads++;
    return { hasUnread: true, streamPositions: at(5) };
  });
  try {
    // The mention is publication 5; the subscription starts after it.
    activityNavAttentionRealtime(queryClient, USER).onSubscribed({
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
  queryClient.setQueryData(activityNavAttentionQuery().queryKey, {
    hasUnread: false,
    streamPositions: at(4),
  });
  const dot = mountedDot(queryClient, async () => {
    reads++;
    return { hasUnread: false, streamPositions: at(4) };
  });
  try {
    const { onSubscribed } = activityNavAttentionRealtime(queryClient, USER);
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
