import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver, type InfiniteData } from "@tanstack/react-query";

import {
  afterConversationAllRead,
  buildThreadUnreadBatches,
  isRetryableMarkAllReadError,
  markConversationAllRead,
  type ThreadUnreadSnapshot,
} from "#src/features/conversations/conversation-mark-all-read";
import { conversationOpenQuery } from "#src/features/conversations/conversation-open-query";
import { channelPageQueryKey } from "#src/features/conversations/conversation-query-keys";
import type { ThreadUnreadBatch } from "#src/features/conversations/thread-unread-inputs";
import { ACTIVITY_INBOX_QUERY_PREFIX } from "#src/features/inbox/activity-inbox-queries";
import { AppError } from "#src/lib/app-error";

describe("buildThreadUnreadBatches", () => {
  test("produces one empty batch when no thread unread marks exist", () => {
    const batches = buildThreadUnreadBatches({ throughSequence: 42, marks: [] }, "op-empty");
    expect(batches).toEqual([{ operationId: "op-empty", throughSequence: 42, marks: [] }]);
  });

  test("chunks marks at 200 per batch while preserving operationId and throughSequence", () => {
    const marks = Array.from({ length: 405 }, (_, index) => ({
      rootMessageId: `root-${index}`,
      version: `v-${index}`,
    }));
    const batches = buildThreadUnreadBatches({ throughSequence: 99, marks }, "op-chunked");
    expect(batches.map((batch) => batch.marks.length)).toEqual([200, 200, 5]);
    expect(batches.every((batch) => batch.operationId === "op-chunked")).toBe(true);
    expect(batches.every((batch) => batch.throughSequence === 99)).toBe(true);
    expect(batches[0]?.marks[0]).toEqual({ rootMessageId: "root-0", version: "v-0" });
    expect(batches[2]?.marks[4]).toEqual({ rootMessageId: "root-404", version: "v-404" });
  });
});

describe("isRetryableMarkAllReadError", () => {
  test("classifies 4xx non-timeout/non-rate-limit errors as permanent and transient errors as retryable", () => {
    expect(isRetryableMarkAllReadError(new AppError("ACCESS_DENIED"))).toBe(false);
    expect(isRetryableMarkAllReadError(new AppError("NOT_FOUND"))).toBe(false);
    expect(isRetryableMarkAllReadError(new AppError("INVALID_INPUT"))).toBe(false);
    expect(isRetryableMarkAllReadError(new AppError("TEMPORARILY_UNAVAILABLE"))).toBe(true);
    expect(isRetryableMarkAllReadError(new AppError("RATE_LIMITED"))).toBe(true);
    expect(isRetryableMarkAllReadError(Object.assign(new Error("timeout"), { status: 408 }))).toBe(
      true,
    );
    expect(isRetryableMarkAllReadError(Object.assign(new Error("gone"), { status: 410 }))).toBe(
      false,
    );
    expect(isRetryableMarkAllReadError(new Error("network reset"))).toBe(true);
  });
});

describe("markConversationAllRead", () => {
  const snapshotOf = (count: number): ThreadUnreadSnapshot => ({
    throughSequence: 120,
    marks: Array.from({ length: count }, (_, index) => ({
      rootMessageId: `root-${index}`,
      version: `ver-${index}`,
    })),
  });

  test("retries only the failed batch without reloading snapshot and notifies cleared batches", async () => {
    let snapshotLoads = 0;
    const sentBatches: ThreadUnreadBatch[] = [];
    const cleared: Array<readonly { rootMessageId: string; version: string }[]> = [];
    const delays: number[] = [];
    let batch2Attempts = 0;

    const result = await markConversationAllRead(
      { kind: "channel", channelId: "chan-1" },
      {
        operationId: () => "op-retry",
        loadSnapshot: async () => {
          snapshotLoads += 1;
          return snapshotOf(205);
        },
        sendBatch: async (_target, batch) => {
          sentBatches.push(batch);
          if (batch.marks[0]?.rootMessageId === "root-200") {
            batch2Attempts += 1;
            if (batch2Attempts === 1) throw new AppError("TEMPORARILY_UNAVAILABLE");
          }
        },
        wait: async (ms) => {
          delays.push(ms);
        },
        onBatchCleared: (marks) => cleared.push(marks),
      },
    );

    expect(snapshotLoads).toBe(1);
    expect(sentBatches).toHaveLength(3);
    expect(sentBatches.map((batch) => batch.marks.length)).toEqual([200, 5, 5]);
    expect(delays).toEqual([300]);
    expect(cleared).toHaveLength(2);
    expect(result).toHaveLength(205);
  });

  test("fails immediately without retrying on non-retryable AppError", async () => {
    let attempts = 0;
    let waited = false;
    await expect(
      markConversationAllRead(
        { kind: "direct", conversationId: "dm-1" },
        {
          loadSnapshot: async () => snapshotOf(1),
          sendBatch: async () => {
            attempts += 1;
            throw new AppError("ACCESS_DENIED");
          },
          wait: async () => {
            waited = true;
          },
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(attempts).toBe(1);
    expect(waited).toBe(false);
  });

  test("rejects after exhausting maxAttempts on transient failures", async () => {
    let attempts = 0;
    const delays: number[] = [];
    await expect(
      markConversationAllRead(
        { kind: "channel", channelId: "chan-2" },
        {
          maxAttempts: 3,
          loadSnapshot: async () => snapshotOf(1),
          sendBatch: async () => {
            attempts += 1;
            throw new AppError("TEMPORARILY_UNAVAILABLE");
          },
          wait: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    ).rejects.toThrow("TEMPORARILY_UNAVAILABLE");
    expect(attempts).toBe(3);
    expect(delays).toEqual([300, 600]);
  });
});

describe("afterConversationAllRead", () => {
  test("clears matching thread unread marks across caches, stales open reads, and invalidates activity", () => {
    const queryClient = new QueryClient();
    const channelKey = channelPageQueryKey("chan-1");
    const directKey = ["conversation", "direct", "dm-1"] as const;
    const activityKey = [...ACTIVITY_INBOX_QUERY_PREFIX, "list", "ws-1"] as const;

    queryClient.setQueryData<
      InfiniteData<
        { messages: { id: string }[]; threadUnreadMarks?: Record<string, string> },
        unknown
      >
    >(channelKey, {
      pages: [
        {
          messages: [{ id: "root-a" }, { id: "root-b" }],
          threadUnreadMarks: { "root-a": "v1", "root-b": "v2-newer" },
        },
      ],
      pageParams: [undefined],
    });
    queryClient.setQueryData<
      InfiniteData<
        { messages: { id: string }[]; threadUnreadMarks?: Record<string, string> },
        unknown
      >
    >(directKey, {
      pages: [
        {
          messages: [{ id: "root-c" }],
          threadUnreadMarks: { "root-c": "v3" },
        },
      ],
      pageParams: [undefined],
    });

    const openConv = conversationOpenQuery("chan-1");
    const openThread = conversationOpenQuery("chan-1", "root-a");
    queryClient.setQueryData(openConv.queryKey, { firstUnread: null });
    queryClient.setQueryData(openThread.queryKey, {
      firstUnread: null,
      markedUnreadVersion: "v1",
    });
    const observer = new QueryObserver(queryClient, {
      queryKey: openThread.queryKey,
      queryFn: async () => ({ firstUnread: null }),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});

    queryClient.setQueryData(activityKey, { items: [] });

    afterConversationAllRead(queryClient, { kind: "channel", channelId: "chan-1" }, [
      { rootMessageId: "root-a", version: "v1" },
      { rootMessageId: "root-b", version: "v1-stale" },
    ]);

    const channelPages =
      queryClient.getQueryData<
        InfiniteData<{ threadUnreadMarks?: Record<string, string> }, unknown>
      >(channelKey)!.pages;
    expect(channelPages[0]?.threadUnreadMarks).toEqual({ "root-b": "v2-newer" });
    expect(queryClient.getQueryData(openConv.queryKey)).toBeUndefined();
    expect(queryClient.getQueryState(openThread.queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(activityKey)?.isInvalidated).toBe(true);

    afterConversationAllRead(queryClient, { kind: "direct", conversationId: "dm-1" }, [
      { rootMessageId: "root-c", version: "v3" },
    ]);
    const directPages =
      queryClient.getQueryData<
        InfiniteData<{ threadUnreadMarks?: Record<string, string> }, unknown>
      >(directKey)!.pages;
    expect(directPages[0]?.threadUnreadMarks).toEqual({});

    unsubscribe();
  });
});
