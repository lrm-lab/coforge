import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePiChatStore } from "#src/pi-chat/storage";

test("persists session metadata, rejects path traversal, and preserves native transcripts on reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-store-"));
  try {
    const store = new FilePiChatStore(directory);
    const id = crypto.randomUUID();
    const row = {
      id,
      title: "Private chat",
      updatedAt: Date.now(),
      status: "idle" as const,
      model: "factory/deepseek",
      requestIds: [crypto.randomUUID()],
    };
    await store.save(row);
    expect(await new FilePiChatStore(directory).list()).toEqual([row]);
    expect(await store.messages(id)).toEqual([]);
    await expect(store.remove("../outside")).rejects.toThrow();
    await store.remove(id);
    expect(await new FilePiChatStore(directory).wasAccepted(row.requestIds[0]!)).toBe(true);
    expect(await store.list()).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
