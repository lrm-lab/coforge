import { describe, expect, test } from "bun:test";
import {
  createThreadUnreadRefresh,
  THREAD_UNREAD_BATCH,
  type ThreadUnreadRow,
} from "#src/features/conversations/thread-unread-refresh";

type Asked = {
  workspaceId: string;
  ids: string[];
  settle: (rows: readonly ThreadUnreadRow[]) => void;
  fail: (cause: unknown) => void;
};

const row = (conversationId: string, unreadThreadCount: number): ThreadUnreadRow => ({
  conversationId,
  unreadThreadCount,
  threadMentioned: false,
});

function harness(options?: { batch?: number }) {
  const asked: Asked[] = [];
  const applied: { workspaceId: string; rows: readonly ThreadUnreadRow[] }[] = [];
  const scheduled: (() => void)[] = [];
  const errors: unknown[] = [];
  const refresh = createThreadUnreadRefresh({
    batch: options?.batch,
    read: (workspaceId, ids) =>
      new Promise<readonly ThreadUnreadRow[]>((resolve, reject) => {
        asked.push({
          workspaceId,
          ids: [...ids],
          settle: (rows) => resolve(rows),
          fail: (cause) => reject(cause),
        });
      }),
    apply: (workspaceId, rows) => applied.push({ workspaceId, rows }),
    onError: (cause) => errors.push(cause),
    schedule: (task) => scheduled.push(task),
  });
  return { refresh, asked, applied, scheduled, errors };
}

describe("createThreadUnreadRefresh", () => {
  test("answers every channel made dirty before one read with that read", async () => {
    const h = harness();
    h.refresh.setWorkspace("w1");
    h.refresh.invalidate("w1", "a");
    h.refresh.invalidate("w1", "b");
    const settled = h.refresh.flush();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.ids.slice().sort()).toEqual(["a", "b"]);
    h.asked[0]?.settle([row("a", 1), row("b", 2)]);
    await settled;
    expect(h.applied).toEqual([{ workspaceId: "w1", rows: [row("a", 1), row("b", 2)] }]);
    expect(h.refresh.pendingCount()).toBe(0);
  });

  test("drops the answer of a channel made dirty again while its read was in flight", async () => {
    const h = harness();
    h.refresh.setWorkspace("w1");
    h.refresh.invalidate("w1", "a");
    const stale = h.refresh.flush();
    h.refresh.invalidate("w1", "a");
    h.asked[0]?.settle([row("a", 1)]);
    await stale;
    expect(h.applied).toEqual([]);

    const again = h.refresh.flush();
    expect(h.asked).toHaveLength(2);
    h.asked[1]?.settle([row("a", 0)]);
    await again;
    expect(h.applied).toEqual([{ workspaceId: "w1", rows: [row("a", 0)] }]);
  });

  test("drops what is pending and what is in flight when the Workspace changes", async () => {
    const h = harness();
    h.refresh.setWorkspace("w1");
    h.refresh.invalidate("w1", "a");
    const inFlight = h.refresh.flush();
    h.refresh.setWorkspace("w2");
    h.asked[0]?.settle([row("a", 3)]);
    await inFlight;
    expect(h.applied).toEqual([]);
    expect(h.refresh.pendingCount()).toBe(0);
  });

  test("ignores a channel of a Workspace the list no longer shows", () => {
    const h = harness();
    h.refresh.setWorkspace("w1");
    h.refresh.invalidate("w2", "a");
    expect(h.refresh.pendingCount()).toBe(0);
    expect(h.asked).toEqual([]);
  });

  test("asks for one batch at a time and continues with the rest", async () => {
    const h = harness({ batch: 2 });
    h.refresh.setWorkspace("w1");
    for (const id of ["a", "b", "c"]) h.refresh.invalidate("w1", id);
    const first = h.refresh.flush();
    expect(h.asked[0]?.ids).toHaveLength(2);
    h.asked[0]?.settle(h.asked[0].ids.map((id) => row(id, 1)));
    await first;
    const second = h.refresh.flush();
    expect(h.asked[1]?.ids).toEqual(["c"]);
    h.asked[1]?.settle([row("c", 1)]);
    await second;
    expect(h.applied.flatMap((entry) => entry.rows.map((each) => each.conversationId))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("keeps the channels of a failed read pending and asks again", async () => {
    const h = harness();
    h.refresh.setWorkspace("w1");
    h.refresh.invalidate("w1", "a");
    const failed = h.refresh.flush();
    h.asked[0]?.fail(new Error("offline"));
    await failed;
    expect(h.errors).toHaveLength(1);
    expect(h.refresh.pendingCount()).toBe(1);
    const retried = h.refresh.flush();
    h.asked[1]?.settle([row("a", 0)]);
    await retried;
    expect(h.applied).toEqual([{ workspaceId: "w1", rows: [row("a", 0)] }]);
  });

  test("automatically re-reads only the channel invalidated during the batch", async () => {
    const applied: ThreadUnreadRow[] = [];
    const reads: string[][] = [];
    const refresh = createThreadUnreadRefresh({
      read: async (workspaceId, ids) => {
        reads.push([...ids]);
        if (reads.length === 1) {
          refresh.invalidate(workspaceId, "a");
          return [row("a", 1), row("b", 1)];
        }
        return [row("a", 0)];
      },
      apply: (_, rows) => applied.push(...rows),
    });
    refresh.setWorkspace("w1");
    refresh.invalidate("w1", "a");
    refresh.invalidate("w1", "b");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reads).toEqual([["a", "b"], ["a"]]);
    expect(applied).toEqual([row("b", 1), row("a", 0)]);
  });

  test("retries the failed channel and later invalidations without another notification", async () => {
    const reads: string[][] = [];
    let failFirst!: (reason: Error) => void;
    const updated = Promise.withResolvers<readonly ThreadUnreadRow[]>();
    const refresh = createThreadUnreadRefresh({
      retryDelays: [0],
      read: (_, ids) => {
        reads.push([...ids]);
        if (reads.length === 1) {
          return new Promise<readonly ThreadUnreadRow[]>((_, reject) => {
            failFirst = reject;
          });
        }
        return Promise.resolve(ids.map((id) => row(id, 0)));
      },
      apply: (_, rows) => updated.resolve(rows),
    });
    refresh.setWorkspace("w1");
    refresh.invalidate("w1", "a");
    await Promise.resolve();
    refresh.invalidate("w1", "b");
    await Promise.resolve();
    failFirst(new Error("503"));
    expect((await updated.promise).map((each) => each.conversationId).sort()).toEqual(["a", "b"]);
    expect(reads).toHaveLength(2);
  }, 500);

  test("cancels a scheduled retry when leaving a Workspace", async () => {
    const reads: string[] = [];
    const failed = Promise.withResolvers<void>();
    const refresh = createThreadUnreadRefresh({
      retryDelays: [0],
      read: async (workspaceId) => {
        reads.push(workspaceId);
        throw new Error("503");
      },
      apply: () => {},
      onError: () => failed.resolve(),
    });
    refresh.setWorkspace("w1");
    refresh.invalidate("w1", "a");
    await failed.promise;
    await Promise.resolve();
    refresh.setWorkspace(undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reads).toEqual(["w1"]);
  });
  test("clears the prior count and mention when the queried channel is omitted", async () => {
    const h = harness();
    h.refresh.setWorkspace("w1");
    h.refresh.invalidate("w1", "a");
    const before = h.refresh.flush();
    h.asked[0]?.settle([{ ...row("a", 1), threadMentioned: true }]);
    await before;

    h.refresh.invalidate("w1", "a");
    const after = h.refresh.flush();
    h.asked[1]?.settle([]);
    await after;

    expect(h.applied.map((each) => each.rows)).toEqual([
      [{ ...row("a", 1), threadMentioned: true }],
      [row("a", 0)],
    ]);
  });

  test("keeps one hundred channels to a read", () => {
    expect(THREAD_UNREAD_BATCH).toBe(100);
  });
});
