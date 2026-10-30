import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  activityNavAttentionQuery,
  activityNavAttentionRealtime,
} from "#src/features/inbox/activity-inbox-queries";
import type { StreamPosition } from "#src/features/realtime/subscription-gap";
import { dataBecomes } from "./helpers/query-cache-harness";

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
    onMessage();
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
