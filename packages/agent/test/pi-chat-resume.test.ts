import { expect, test } from "bun:test";
import { PiChatSessions, type PiChatRuntime, type PiChatStore } from "#src/pi-chat/sessions";
import type { PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";

function fixture() {
  const records = new Map<string, PiChatSession>();
  const checkpoints = new Map<
    string,
    {
      requestId: string;
      message: string;
      messageCount: number;
      stopRequested?: boolean;
    }
  >();
  const store = {
    list: async () => [...records.values()].map((row) => ({ ...row })),
    save: async (row: PiChatSession) => {
      records.set(row.id, { ...row });
    },
    messages: async () => [],
    remove: async (id: string) => {
      records.delete(id);
      checkpoints.delete(id);
    },
    wasAccepted: async () => false,
    checkpoint: async (id: string) => checkpoints.get(id),
    saveCheckpoint: async (
      id: string,
      checkpoint: NonNullable<ReturnType<typeof checkpoints.get>>,
    ) => {
      checkpoints.set(id, { ...checkpoint });
    },
    clearCheckpoint: async (id: string) => {
      checkpoints.delete(id);
    },
  } satisfies PiChatStore & Record<string, unknown>;
  const resumed: string[] = [];
  const prompted: string[] = [];
  const ends = new Map<string, () => void>();
  const resumedWaiters = new Map<string, () => void>();
  const disposed: string[] = [];
  const disposedWaiters = new Map<string, () => void>();
  let failAbort = false;
  const factory = async (id: string = crypto.randomUUID()): Promise<PiChatRuntime> => ({
    id,
    model: () => "fixture/model",
    messages: () => [],
    prompt: async (text) => {
      expect(checkpoints.get(id)?.message).toBe(text);
      prompted.push(text);
      await new Promise<void>((resolve) => {
        ends.set(id, resolve);
      });
    },
    resume: async () => {
      resumed.push(id);
      resumedWaiters.get(id)?.();
      await new Promise<void>((resolve) => {
        ends.set(id, resolve);
      });
    },
    abort: async () => {
      if (failAbort) throw new Error("lost process");
      ends.get(id)?.();
    },
    dispose: async () => {
      disposed.push(id);
      disposedWaiters.get(id)?.();
    },
  });
  return {
    records,
    checkpoints,
    store,
    factory,
    resumed,
    prompted,
    disposed,
    finish: (id: string) => ends.get(id)?.(),
    whenResumed: (id: string) =>
      new Promise<void>((resolve) => {
        if (resumed.includes(id)) resolve();
        else resumedWaiters.set(id, resolve);
      }),
    whenDisposed: (id: string) =>
      new Promise<void>((resolve) => {
        if (disposed.includes(id)) resolve();
        else disposedWaiters.set(id, resolve);
      }),
    failAbort: (value: boolean) => {
      failAbort = value;
    },
  };
}

test("a restarted worker automatically continues its accepted task without resending the user message", async () => {
  const f = fixture();
  const id = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  f.records.set(id, {
    id,
    title: "Saved task",
    updatedAt: Date.now(),
    status: "running",
    model: "fixture/model",
    requestIds: [requestId],
  });
  f.checkpoints.set(id, { requestId, message: "Do the task once", messageCount: 0 });
  const sessions = new PiChatSessions(f.store, f.factory);
  try {
    expect((await sessions.list())[0]?.status).toBe("running");
    expect(f.resumed).toEqual([id]);
    expect(f.prompted).toEqual([]);
    expect(
      (await sessions.start({ sessionId: id, requestId, message: "Do the task once" })).requestIds,
    ).toEqual([requestId]);
    expect(f.resumed).toEqual([id]);
  } finally {
    await sessions.dispose();
  }
});

test("restored work respects the four-turn limit and starts queued recovery when a slot opens", async () => {
  const f = fixture();
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (const id of ids) {
    const requestId = crypto.randomUUID();
    f.records.set(id, {
      id,
      title: id,
      updatedAt: Date.now(),
      status: "running",
      model: "fixture/model",
      requestIds: [requestId],
    });
    f.checkpoints.set(id, { requestId, message: "Recover", messageCount: 0 });
  }
  const sessions = new PiChatSessions(f.store, f.factory);
  try {
    expect((await sessions.list()).filter((row) => row.status === "running")).toHaveLength(4);
    expect(f.resumed).toHaveLength(4);
    const admitted = f.whenResumed(ids[4]!);
    f.finish(ids[0]!);
    await admitted;
    expect(f.resumed).toHaveLength(5);
    expect((await sessions.list()).filter((row) => row.status === "running")).toHaveLength(4);
  } finally {
    await sessions.dispose();
  }
});

test("a failed recovery admission disposes its native session and retains the checkpoint", async () => {
  const f = fixture();
  const id = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  f.records.set(id, {
    id,
    title: id,
    updatedAt: Date.now(),
    status: "running",
    model: "fixture/model",
    requestIds: [requestId],
  });
  f.checkpoints.set(id, { requestId, message: "Recover", messageCount: 0 });
  const sessions = new PiChatSessions(
    {
      ...f.store,
      save: async (row) => {
        if (row.status === "running") throw new Error("disk full");
        await f.store.save(row);
      },
    },
    f.factory,
  );
  try {
    expect((await sessions.list())[0]?.status).toBe("interrupted");
    expect(f.disposed).toEqual([id]);
    expect(f.checkpoints.has(id)).toBe(true);
  } finally {
    await sessions.dispose();
  }
});

test("renaming a queued conversation preserves its automatic continuation", async () => {
  const f = fixture();
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (const id of ids) {
    const requestId = crypto.randomUUID();
    f.records.set(id, {
      id,
      title: id,
      updatedAt: Date.now(),
      status: "running",
      model: "fixture/model",
      requestIds: [requestId],
    });
    f.checkpoints.set(id, { requestId, message: "Recover", messageCount: 0 });
  }
  const sessions = new PiChatSessions(f.store, f.factory);
  try {
    await sessions.list();
    await sessions.rename(ids[4]!, "Renamed while waiting");
    const settled = f.whenDisposed(ids[0]!);
    f.finish(ids[0]!);
    await settled;
    await sessions.rename(ids[0]!, "Completed");
    expect(f.resumed).toContain(ids[4]!);
    expect((await sessions.list()).find((row) => row.id === ids[4])?.title).toBe(
      "Renamed while waiting",
    );
  } finally {
    await sessions.dispose();
  }
});

test("worker shutdown preserves continuation while an explicit user stop survives the next restart", async () => {
  const f = fixture();
  const first = new PiChatSessions(f.store, f.factory);
  const row = await first.start({ requestId: crypto.randomUUID(), message: "Finish my task" });
  await first.dispose();
  expect(f.records.get(row.id)?.status).toBe("interrupted");
  expect(f.checkpoints.has(row.id)).toBe(true);
  const second = new PiChatSessions(f.store, f.factory);
  try {
    expect((await second.list())[0]?.status).toBe("running");
    await second.stop(row.id);
    expect(f.records.get(row.id)?.status).toBe("stopped");
    expect(f.checkpoints.has(row.id)).toBe(false);
  } finally {
    await second.dispose();
  }
  const third = new PiChatSessions(f.store, f.factory);
  try {
    expect((await third.list())[0]?.status).toBe("stopped");
    expect(f.resumed).toEqual([row.id]);
  } finally {
    await third.dispose();
  }
});

test("a stop intent is durable before abort, so a crash cannot turn Stop into automatic continuation", async () => {
  const f = fixture();
  const sessions = new PiChatSessions(f.store, f.factory);
  const row = await sessions.start({ requestId: crypto.randomUUID(), message: "Work" });
  f.failAbort(true);
  await expect(sessions.stop(row.id)).rejects.toThrow("lost process");
  expect(f.checkpoints.get(row.id)?.stopRequested).toBe(true);
  const restarted = new PiChatSessions(f.store, f.factory);
  try {
    expect((await restarted.list())[0]?.status).toBe("stopped");
    expect(f.resumed).toEqual([]);
  } finally {
    f.failAbort(false);
    await sessions.dispose();
    await restarted.dispose();
  }
});
