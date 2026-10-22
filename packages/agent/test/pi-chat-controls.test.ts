import { expect, test } from "bun:test";
import { PiChatSessions, type PiChatRuntime, type PiChatStore } from "#src/pi-chat/sessions";
import type { PiChatCheckpoint } from "#src/pi-chat/checkpoint";
import type { PiChatUpdate, PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";

function fixture() {
  const records = new Map<string, PiChatSession>(),
    checkpoints = new Map<string, PiChatCheckpoint>();
  const accepted = new Set<string>();
  const done = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const onUpdate = (update: PiChatUpdate) => {
    if (update.session && update.session.status !== "running") settled.resolve();
  };
  let queued = 0,
    created = 0;
  const queue = { steering: [] as string[], followUp: [] as string[] };
  const store: PiChatStore = {
    list: async () => [...records.values()],
    save: async (row) => {
      records.set(row.id, structuredClone(row));
      row.requestIds.forEach((id) => accepted.add(id));
    },
    remove: async (id) => {
      records.delete(id);
      checkpoints.delete(id);
    },
    wasAccepted: async (id) => accepted.has(id),
    messages: async () => [],
    checkpoint: async (id) => checkpoints.get(id),
    saveCheckpoint: async (id, value) => {
      checkpoints.set(id, structuredClone(value));
    },
    clearCheckpoint: async (id) => {
      checkpoints.delete(id);
    },
  };
  const factory = async (id?: string): Promise<PiChatRuntime> => {
    created++;
    return {
      id: id ?? crypto.randomUUID(),
      model: () => "fixture/model",
      messages: () => [],
      prompt: () => done.promise,
      resume: () => done.promise,
      dispose: async () => {},
      abort: async () => {
        queue.steering.length = queue.followUp.length = 0;
        done.resolve();
      },
      enqueue: async (text, mode) => {
        queued++;
        queue[mode === "steer" ? "steering" : "followUp"].push(text);
        return "queued";
      },
      queue: () => structuredClone(queue),
      takeQueue: () => {
        const result = structuredClone(queue);
        queue.steering.length = queue.followUp.length = 0;
        return result;
      },
    };
  };
  return {
    store,
    factory,
    records,
    checkpoints,
    created: () => created,
    queued: () => queued,
    done,
    settled,
    onUpdate,
  };
}

test("a running turn accepts deduplicated steering and follow-ups and can return queued messages for editing", async () => {
  const f = fixture();
  const sessions = new PiChatSessions(f.store, f.factory, f.onUpdate);
  try {
    const first = await sessions.start({ requestId: crypto.randomUUID(), message: "original" });
    const input = {
      sessionId: first.id,
      requestId: crypto.randomUUID(),
      message: "steer",
      mode: "steer" as const,
    };
    await sessions.start(input);
    await sessions.start(input);
    await sessions.start({
      ...input,
      requestId: crypto.randomUUID(),
      message: "later",
      mode: "followUp",
    });
    expect(f.queued()).toBe(2);
    expect((await sessions.read(first.id)).queue).toEqual({
      steering: ["steer"],
      followUp: ["later"],
    });
    expect(f.checkpoints.get(first.id)?.queued).toHaveLength(2);
    const taken = await sessions.execute({ action: "take_queue", sessionId: first.id });
    expect(taken.takenQueue).toEqual({ steering: ["steer"], followUp: ["later"] });
    expect((await sessions.read(first.id)).queue).toEqual({ steering: [], followUp: [] });
    await sessions.start(input);
    expect(f.queued()).toBe(2);
    await sessions.execute({ action: "delete", sessionId: first.id, stop: true });
    expect(await sessions.list()).toEqual([]);
  } finally {
    await sessions.dispose();
  }
});

test("worker recovery keeps uncertain queued input visible without automatically repeating it", async () => {
  const f = fixture();
  const id = crypto.randomUUID(),
    requestId = crypto.randomUUID(),
    queuedId = crypto.randomUUID();
  const queued = [
    { id: queuedId, text: "do not repeat an uncertain action", mode: "steer" as const },
  ];
  await f.store.save({
    id,
    title: "interrupted",
    status: "running",
    model: "fixture/model",
    requestIds: [requestId, queuedId],
    updatedAt: 1,
  });
  await f.store.saveCheckpoint(id, { requestId, message: "original", messageCount: 0, queued });
  const sessions = new PiChatSessions(f.store, f.factory, f.onUpdate);
  try {
    expect((await sessions.read(id)).session).toMatchObject({
      status: "interrupted",
      interruptedInputs: queued,
    });
    expect(f.created()).toBe(0);
    await sessions.start({
      sessionId: id,
      requestId: queuedId,
      message: queued[0]!.text,
      mode: "steer",
    });
    expect(f.queued()).toBe(0);
  } finally {
    await sessions.dispose();
  }
});

test("settlement waits for input admission and preserves an input queued after prompt completion", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const sessions = new PiChatSessions(
    f.store,
    async (id) => {
      const runtime = await f.factory(id);
      const enqueue = runtime.enqueue!;
      runtime.enqueue = async (text, mode) => {
        entered.resolve();
        await release.promise;
        return enqueue(text, mode);
      };
      return runtime;
    },
    f.onUpdate,
  );
  try {
    const first = await sessions.start({ requestId: crypto.randomUUID(), message: "original" });
    const input = {
      sessionId: first.id,
      requestId: crypto.randomUUID(),
      message: "late instruction",
      mode: "steer" as const,
    };
    const sending = sessions.start(input);
    await entered.promise;
    f.done.resolve();
    await f.done.promise;
    expect((await sessions.read(first.id)).session.status).toBe("running");
    release.resolve();
    await sending;
    await f.settled.promise;
    expect((await sessions.read(first.id)).session).toMatchObject({
      status: "interrupted",
      interruptedInputs: [{ id: input.requestId, text: input.message, mode: "steer" }],
    });
    expect(f.checkpoints.has(first.id)).toBe(true);
  } finally {
    release.resolve();
    f.done.resolve();
    await sessions.dispose();
  }
});

test("admission fences settlement before the first durable write completes", async () => {
  const f = fixture();
  const sessions = new PiChatSessions(f.store, f.factory, f.onUpdate);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    const first = await sessions.start({ requestId: crypto.randomUUID(), message: "original" });
    const save = f.store.saveCheckpoint;
    f.store.saveCheckpoint = async (id, checkpoint) => {
      if (checkpoint.queued?.length) {
        entered.resolve();
        await release.promise;
      }
      await save(id, checkpoint);
    };
    const input = {
      sessionId: first.id,
      requestId: crypto.randomUUID(),
      message: "late persistence",
      mode: "followUp" as const,
    };
    const sending = sessions.start(input);
    await entered.promise;
    f.done.resolve();
    await f.done.promise;
    expect((await sessions.read(first.id)).session.status).toBe("running");
    release.resolve();
    await sending;
    await f.settled.promise;
    expect((await sessions.read(first.id)).session.interruptedInputs).toContainEqual({
      id: input.requestId,
      text: input.message,
      mode: input.mode,
    });
    expect(f.checkpoints.has(first.id)).toBe(true);
  } finally {
    release.resolve();
    f.done.resolve();
    await sessions.dispose();
  }
});

test("taken text survives a lost response, repeated take and worker reload until accepted resend", async () => {
  const f = fixture();
  let sessions = new PiChatSessions(f.store, f.factory, f.onUpdate);
  try {
    const first = await sessions.start({ requestId: crypto.randomUUID(), message: "original" });
    await sessions.start({
      sessionId: first.id,
      requestId: crypto.randomUUID(),
      message: "keep this text",
      mode: "steer",
    });
    await sessions.takeQueue(first.id); // Simulate a lost response.
    expect((await sessions.takeQueue(first.id)).takenQueue).toEqual({
      steering: ["keep this text"],
      followUp: [],
    });
    expect((await sessions.read(first.id)).session.heldQueue).toEqual({
      steering: ["keep this text"],
      followUp: [],
    });
    await sessions.stop(first.id);
    await sessions.dispose();
    sessions = new PiChatSessions(f.store, f.factory, f.onUpdate);
    expect((await sessions.read(first.id)).session.heldQueue?.steering).toEqual(["keep this text"]);
    await sessions.start({
      sessionId: first.id,
      requestId: crypto.randomUUID(),
      message: "edited text",
    });
    expect((await sessions.read(first.id)).session.heldQueue).toBeUndefined();
  } finally {
    await sessions.dispose();
  }
});

test("a failed take-back write retains recovery intent instead of losing text", async () => {
  const f = fixture();
  const sessions = new PiChatSessions(f.store, f.factory, f.onUpdate);
  try {
    const first = await sessions.start({ requestId: crypto.randomUUID(), message: "original" });
    await sessions.start({
      sessionId: first.id,
      requestId: crypto.randomUUID(),
      message: "recover me",
      mode: "steer",
    });
    const save = f.store.save;
    let failed = false;
    f.store.save = async (row) => {
      if (row.heldQueue && !failed) {
        failed = true;
        throw new Error("fixture write failure");
      }
      await save(row);
    };
    await expect(sessions.takeQueue(first.id)).rejects.toThrow("fixture write failure");
    expect(f.checkpoints.get(first.id)?.queued?.[0]?.text).toBe("recover me");
    expect((await sessions.read(first.id)).session.heldQueue?.steering).toEqual(["recover me"]);
  } finally {
    await sessions.dispose();
  }
});

test("a failed admission index write preserves durable accepted intent at settlement", async () => {
  const f = fixture();
  const sessions = new PiChatSessions(f.store, f.factory, f.onUpdate);
  try {
    const first = await sessions.start({ requestId: crypto.randomUUID(), message: "original" });
    const save = f.store.save;
    let failed = false;
    f.store.save = async (row) => {
      if (row.requestIds.length === 2 && !failed) {
        failed = true;
        throw new Error("fixture index failure");
      }
      await save(row);
    };
    const input = {
      sessionId: first.id,
      requestId: crypto.randomUUID(),
      message: "durable instruction",
      mode: "steer" as const,
    };
    await expect(sessions.start(input)).rejects.toThrow("fixture index failure");
    f.done.resolve();
    await f.settled.promise;
    expect((await sessions.read(first.id)).session).toMatchObject({
      status: "interrupted",
      interruptedInputs: [{ id: input.requestId, text: input.message, mode: input.mode }],
    });
    expect(f.checkpoints.has(first.id)).toBe(true);
  } finally {
    await sessions.dispose();
  }
});

test("taking back a later input does not erase an earlier unconfirmed input", async () => {
  const f = fixture();
  let sessions = new PiChatSessions(
    f.store,
    async (id) => {
      const runtime = await f.factory(id),
        enqueue = runtime.enqueue!;
      runtime.enqueue = async (text, mode) => {
        if (text === "unconfirmed A") throw new Error("fixture hook failure");
        return enqueue(text, mode);
      };
      return runtime;
    },
    f.onUpdate,
  );
  try {
    const first = await sessions.start({ requestId: crypto.randomUUID(), message: "original" });
    const a = {
      sessionId: first.id,
      requestId: crypto.randomUUID(),
      message: "unconfirmed A",
      mode: "steer" as const,
    };
    await expect(sessions.start(a)).rejects.toThrow("fixture hook failure");
    await sessions.start({
      sessionId: first.id,
      requestId: crypto.randomUUID(),
      message: "pending B",
      mode: "steer",
    });
    await sessions.takeQueue(first.id);
    f.done.resolve();
    await f.settled.promise;
    expect((await sessions.read(first.id)).session.interruptedInputs).toContainEqual({
      id: a.requestId,
      text: a.message,
      mode: a.mode,
    });
    await sessions.dispose();
    sessions = new PiChatSessions(f.store, f.factory, f.onUpdate);
    const restored = await sessions.read(first.id);
    expect(restored.session.interruptedInputs).toContainEqual({
      id: a.requestId,
      text: a.message,
      mode: a.mode,
    });
    expect(restored.session.heldQueue?.steering).toEqual(["pending B"]);
  } finally {
    await sessions.dispose();
  }
});

test("restart merges older unconfirmed inputs with the latest durable queued intent", async () => {
  const f = fixture(),
    id = crypto.randomUUID(),
    requestId = crypto.randomUUID();
  const older = { id: crypto.randomUUID(), text: "older unconfirmed", mode: "steer" as const };
  const latest = { id: crypto.randomUUID(), text: "latest queued", mode: "followUp" as const };
  await f.store.save({
    id,
    title: "restart",
    status: "running",
    model: "fixture/model",
    updatedAt: 1,
    requestIds: [requestId, older.id],
    interruptedInputs: [older],
  });
  await f.store.saveCheckpoint(id, {
    requestId,
    message: "original",
    messageCount: 0,
    queued: [latest],
  });
  const sessions = new PiChatSessions(f.store, f.factory, f.onUpdate);
  try {
    const row = (await sessions.read(id)).session;
    expect(row.interruptedInputs).toEqual([older, latest]);
    expect(row.requestIds).toContain(latest.id);
  } finally {
    await sessions.dispose();
  }
});
