import { describe, expect, test } from "bun:test";
import { PiChatSessions, type PiChatRuntime, type PiChatStore } from "#src/pi-chat/sessions";
import type { PiChatMessage, PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";

function fixture() {
  const records = new Map<string, PiChatSession>();
  const histories = new Map<string, PiChatMessage[]>();
  const accepted = new Set<string>();
  const store: PiChatStore = {
    list: async () => [...records.values()].map((row) => ({ ...row })),
    save: async (row) => {
      records.set(row.id, { ...row });
      for (const id of row.requestIds) accepted.add(id);
    },
    remove: async (id) => {
      records.delete(id);
      histories.delete(id);
    },
    messages: async (id) => histories.get(id) ?? [],
    wasAccepted: async (id) => accepted.has(id),
  };
  let calls = 0;
  let finish: (() => void) | undefined;
  const factory = async (id?: string): Promise<PiChatRuntime> => {
    const sessionId = id ?? crypto.randomUUID();
    const messages = histories.get(sessionId) ?? [];
    histories.set(sessionId, messages);
    return {
      id: sessionId,
      model: () => "factory/deepseek",
      messages: () => messages,
      prompt: async (text) => {
        calls++;
        messages.push({ id: crypto.randomUUID(), role: "user", text });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        messages.push({ id: crypto.randomUUID(), role: "assistant", text: "x".repeat(9000) });
      },
      abort: async () => {
        finish?.();
      },
      dispose: async () => {},
    };
  };
  return { store, factory, records, histories, calls: () => calls, finish: () => finish?.() };
}

describe("Pi chat sessions", () => {
  test("reports a running session until its final state is saved and mutations are available", async () => {
    const f = fixture();
    const saving = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sessions = new PiChatSessions(
      {
        ...f.store,
        save: async (row) => {
          if (row.status === "idle") {
            saving.resolve();
            await release.promise;
          }
          await f.store.save(row);
        },
      },
      f.factory,
    );
    try {
      const started = await sessions.start({ requestId: crypto.randomUUID(), message: "hello" });
      f.finish();
      await saving.promise;
      expect((await sessions.read(started.id)).session.status).toBe("running");
      release.resolve();
      await sessions.stop(started.id);
      expect((await sessions.rename(started.id, "Settled")).title).toBe("Settled");
      await sessions.remove(started.id);
      expect(await sessions.list()).toEqual([]);
    } finally {
      release.resolve();
      await sessions.dispose();
    }
  });
  test("a delayed send cannot recreate a deleted conversation or repeat its tools", async () => {
    const f = fixture();
    const sessions = new PiChatSessions(f.store, f.factory);
    const requestId = crypto.randomUUID();
    const first = await sessions.start({ requestId, message: "run once" });
    await sessions.stop(first.id);
    await sessions.remove(first.id);
    const restored = new PiChatSessions(f.store, f.factory);
    await expect(restored.start({ requestId, message: "run once" })).rejects.toThrow("deleted");
    expect(f.calls()).toBe(1);
  });
  test("keeps independent conversations and full output; an accepted request never runs twice", async () => {
    const f = fixture();
    const sessions = new PiChatSessions(f.store, f.factory);
    const requestId = crypto.randomUUID();
    const first = await sessions.start({ requestId, message: "First question" });
    expect(first.status).toBe("running");
    expect((await sessions.start({ requestId, message: "First question" })).id).toBe(first.id);
    expect(f.calls()).toBe(1);
    await expect(
      sessions.start({ sessionId: first.id, requestId: crypto.randomUUID(), message: "overlap" }),
    ).rejects.toThrow("busy");
    await sessions.stop(first.id);
    expect((await sessions.read(first.id)).messages.at(-1)?.text).toHaveLength(9000);
    expect((await sessions.read(first.id)).session.status).toBe("stopped");
    const second = await sessions.start({
      requestId: crypto.randomUUID(),
      message: "Second question",
    });
    expect(second.id).not.toBe(first.id);
    expect((await sessions.read(second.id)).messages[0]?.text).toBe("Second question");
    await sessions.dispose();
  });

  test("restores sessions after a worker restart without replaying an interrupted request", async () => {
    const f = fixture();
    const sessionId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    await f.store.save({
      id: sessionId,
      title: "Saved",
      updatedAt: Date.now(),
      status: "running",
      requestIds: [requestId],
      model: "factory/deepseek",
    });
    const sessions = new PiChatSessions(f.store, f.factory);
    expect((await sessions.list())[0]?.status).toBe("interrupted");
    expect((await sessions.start({ sessionId, requestId, message: "do not repeat" })).id).toBe(
      sessionId,
    );
    expect(f.calls()).toBe(0);
    await sessions.rename(sessionId, "Renamed");
    expect((await sessions.list())[0]?.title).toBe("Renamed");
    await sessions.remove(sessionId);
    await expect(sessions.read(sessionId)).rejects.toThrow("not found");
  });

  test("rejects a duplicate request bound to another session", async () => {
    const f = fixture();
    const sessions = new PiChatSessions(f.store, f.factory);
    const requestId = crypto.randomUUID();
    const first = await sessions.start({ requestId, message: "first" });
    await expect(
      sessions.start({ sessionId: crypto.randomUUID(), requestId, message: "other" }),
    ).rejects.toThrow("request");
    await sessions.stop(first.id);
    await sessions.dispose();
  });
});
