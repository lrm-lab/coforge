import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  activityNavAttentionQuery,
  activityNavAttentionRealtime,
} from "#src/features/inbox/activity-inbox-queries";
import { dataBecomes } from "./helpers/query-cache-harness";

/**
 * Task #289: the nav Activity dot cleared only in the tab that marked the inbox read. Its realtime
 * handler set `{ hasUnread: true }` for every signal, so the `activity.changed.v1` another tab's
 * Done or read-all announces could never un-light this tab's dot. `onActivity` now re-reads the
 * boolean; `onMessage` still lights it locally because a message can only add attention.
 */
function mountedDot(queryClient: QueryClient, read: () => Promise<{ hasUnread: boolean }>) {
  const queryKey = activityNavAttentionQuery().queryKey;
  const observer = new QueryObserver(queryClient, {
    ...activityNavAttentionQuery(),
    queryFn: read,
  });
  const unsubscribe = observer.subscribe(() => {});
  return {
    queryKey,
    unsubscribe,
    data: () => queryClient.getQueryData<{ hasUnread: boolean }>(queryKey),
  };
}

test("a message lights the nav dot without reading the server", async () => {
  const queryClient = new QueryClient();
  let reads = 0;
  const read = async () => {
    reads++;
    return { hasUnread: false };
  };
  // Fresh data keeps the mount below from fetching (staleTime is 30 s).
  queryClient.setQueryData(activityNavAttentionQuery().queryKey, { hasUnread: false });
  const dot = mountedDot(queryClient, read);
  try {
    const { onMessage } = activityNavAttentionRealtime(queryClient);
    onMessage();
    expect(dot.data()).toEqual({ hasUnread: true });
    expect(reads).toBe(0);
  } finally {
    dot.unsubscribe();
  }
});

test("an activity change re-reads the dot, so another tab's read-all un-lights this one", async () => {
  const queryClient = new QueryClient();
  const dot = mountedDot(queryClient, async () => ({ hasUnread: false }));
  try {
    // The dot is lit and fresh: nothing refetches it on its own (staleTime is 30 s).
    queryClient.setQueryData(dot.queryKey, { hasUnread: true });
    const { onActivity } = activityNavAttentionRealtime(queryClient);
    onActivity();
    await dataBecomes<{ hasUnread: boolean }>(
      queryClient,
      dot.queryKey,
      (d) => d.hasUnread === false,
    );
    expect(dot.data()).toEqual({ hasUnread: false });
  } finally {
    dot.unsubscribe();
  }
});
