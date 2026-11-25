import { expect, test } from "bun:test";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";

import { createActivityDoneCoordinator } from "#src/features/inbox/activity-inbox-done";
import {
  ACTIVITY_INBOX_LISTS_KEY,
  activityNavAttentionQuery,
  optimisticallyCompleteActivityItems,
} from "#src/features/inbox/activity-inbox-queries";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const item = (
  key: string,
  overrides?: { unreadCount?: number; unreadMention?: boolean; task?: { boardId: string } | null },
) => ({
  key,
  unreadCount: overrides?.unreadCount ?? 1,
  unreadMention: overrides?.unreadMention ?? false,
  ...(overrides?.task !== undefined ? { task: overrides.task } : {}),
});

function inboxData(items: ReturnType<typeof item>[]) {
  return {
    pages: [
      {
        items,
        pinned: [],
        unreadItemCount: items.filter((entry) => entry.unreadCount > 0).length,
        unreadMentionItemCount: items.filter((entry) => entry.unreadMention).length,
        unreadTaskItemCount: items.filter((entry) => Boolean(entry.task) && entry.unreadCount > 0)
          .length,
        unreadArtifactItemCount: items.filter(
          (entry) => entry.key.startsWith("artifact:") && entry.unreadCount > 0,
        ).length,
        activeItemCount: items.length,
      },
    ],
    pageParams: [undefined],
  };
}

test("optimisticallyCompleteActivityItems removes completed items across all cached filters for the workspace", () => {
  const queryClient = new QueryClient();
  const first = item("conversation:1", { unreadCount: 2, unreadMention: true });
  const second = item("artifact:2", { unreadCount: 1 });
  const third = item("conversation:task-3", { unreadCount: 1, task: { boardId: "b1" } });
  const otherWorkspaceItem = item("conversation:1", { unreadCount: 1 });

  const allKey = [...ACTIVITY_INBOX_LISTS_KEY, "ws-1", "all"];
  const unreadKey = [...ACTIVITY_INBOX_LISTS_KEY, "ws-1", "unread"];
  const otherWsKey = [...ACTIVITY_INBOX_LISTS_KEY, "ws-2", "all"];

  queryClient.setQueryData(allKey, inboxData([first, second, third]));
  queryClient.setQueryData(unreadKey, inboxData([first, second, third]));
  queryClient.setQueryData(otherWsKey, inboxData([otherWorkspaceItem]));

  optimisticallyCompleteActivityItems(queryClient, "ws-1", [first]);

  expect(
    queryClient.getQueryData<InfiniteData<ReturnType<typeof inboxData>["pages"][0]>>(allKey)
      ?.pages[0],
  ).toMatchObject({
    items: [second, third],
    activeItemCount: 2,
    unreadItemCount: 2,
    unreadMentionItemCount: 0,
    unreadTaskItemCount: 1,
    unreadArtifactItemCount: 1,
  });

  optimisticallyCompleteActivityItems(queryClient, "ws-1", [third]);

  expect(
    queryClient.getQueryData<InfiniteData<ReturnType<typeof inboxData>["pages"][0]>>(allKey)
      ?.pages[0],
  ).toMatchObject({
    items: [second],
    activeItemCount: 1,
    unreadItemCount: 1,
    unreadMentionItemCount: 0,
    unreadTaskItemCount: 0,
    unreadArtifactItemCount: 1,
  });
  expect(
    queryClient.getQueryData<InfiniteData<ReturnType<typeof inboxData>["pages"][0]>>(unreadKey)
      ?.pages[0],
  ).toMatchObject({
    items: [second],
    activeItemCount: 1,
    unreadItemCount: 1,
    unreadMentionItemCount: 0,
    unreadTaskItemCount: 0,
  });
  expect(
    queryClient.getQueryData<InfiniteData<ReturnType<typeof inboxData>["pages"][0]>>(otherWsKey)
      ?.pages[0],
  ).toMatchObject({
    items: [otherWorkspaceItem],
    activeItemCount: 1,
  });

  queryClient.clear();
});

test("optimisticallyCompleteActivityItems updates cached nav attention unread state", () => {
  const queryClient = new QueryClient();
  const navKey = activityNavAttentionQuery("ws-1").queryKey;
  queryClient.setQueryData(navKey, {
    hasUnread: true,
    unreadCount: 2,
    unreadKeys: ["conversation:1", "conversation:2"],
    streamPositions: {},
  });

  optimisticallyCompleteActivityItems(queryClient, "ws-1", [item("conversation:1")]);
  expect(queryClient.getQueryData(navKey)).toMatchObject({
    hasUnread: true,
    unreadCount: 1,
    unreadKeys: ["conversation:2"],
  });

  optimisticallyCompleteActivityItems(queryClient, "ws-1", [item("conversation:2")]);
  expect(queryClient.getQueryData(navKey)).toMatchObject({
    hasUnread: false,
    unreadCount: 0,
    unreadKeys: [],
  });

  queryClient.clear();
});

test("createActivityDoneCoordinator coalesces rapid Done bursts into one reconciliation and absorbs realtime echoes", async () => {
  const started: string[] = [];
  const settled: string[] = [];
  let reconcileCount = 0;
  let externalRealtimeCount = 0;
  let staleMarkCount = 0;

  const write1 = deferred();
  const write2 = deferred();
  const reconcileDone = deferred();

  const coordinator = createActivityDoneCoordinator({
    reconcileDelayMs: 10,
    onStart: (entry) => started.push(entry.key),
    onSettle: (entry) => settled.push(entry.key),
    onMarkOtherListsStale: () => {
      staleMarkCount += 1;
    },
    onReconcile: async () => {
      reconcileCount += 1;
      await reconcileDone.promise;
    },
    onExternalRealtimeActivity: () => {
      externalRealtimeCount += 1;
    },
  });

  coordinator.onRealtimeActivity();
  expect(externalRealtimeCount).toBe(1);

  const first = item("conversation:1");
  const second = item("conversation:2");
  coordinator.enqueue(
    first,
    () => write1.promise,
    () => {},
  );
  coordinator.enqueue(
    second,
    () => write2.promise,
    () => {},
  );

  expect(started).toEqual(["conversation:1", "conversation:2"]);
  expect(settled).toEqual([]);

  coordinator.onRealtimeActivity();
  expect(externalRealtimeCount).toBe(1);

  write1.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toEqual([]);
  expect(reconcileCount).toBe(0);

  write2.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(staleMarkCount).toBe(2);

  coordinator.onRealtimeActivity();
  expect(externalRealtimeCount).toBe(1);

  await Bun.sleep(25);
  expect(reconcileCount).toBe(1);
  expect(settled).toEqual([]);

  reconcileDone.resolve();
  await Bun.sleep(5);
  expect(settled).toEqual(["conversation:1", "conversation:2"]);

  coordinator.onRealtimeActivity();
  expect(externalRealtimeCount).toBe(2);
  coordinator.dispose();
});

test("createActivityDoneCoordinator immediately settles and reconciles a failed Done while keeping succeeded siblings hidden until reconciliation", async () => {
  const settled: string[] = [];
  const failed: string[] = [];
  let reconcileCount = 0;

  const write1 = deferred();
  const write2 = deferred();
  const reconcileDone = deferred();

  const coordinator = createActivityDoneCoordinator({
    reconcileDelayMs: 10,
    onStart: () => {},
    onSettle: (entry) => settled.push(entry.key),
    onMarkOtherListsStale: () => {},
    onReconcile: async () => {
      reconcileCount += 1;
      await reconcileDone.promise;
    },
    onExternalRealtimeActivity: () => {},
  });

  const first = item("conversation:1");
  const second = item("conversation:2");
  coordinator.enqueue(
    first,
    () => write1.promise,
    () => failed.push(first.key),
  );
  coordinator.enqueue(
    second,
    () => write2.promise,
    () => failed.push(second.key),
  );

  write1.resolve();
  await Bun.sleep(5);
  expect(settled).toEqual([]);

  write2.reject(new Error("boom"));
  await Bun.sleep(5);

  expect(failed).toEqual(["conversation:2"]);
  expect(settled).toEqual(["conversation:2"]);
  expect(reconcileCount).toBe(1);

  reconcileDone.resolve();
  await Bun.sleep(5);
  expect(settled).toEqual(["conversation:2", "conversation:1"]);
  coordinator.dispose();
});
