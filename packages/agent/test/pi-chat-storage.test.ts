import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePiChatStore } from "#src/pi-chat/storage";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PI_SESSION_DIR } from "#src/paths";

async function linkedSession() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-chat-linked-"));
  const physical = join(root, "physical");
  const linked = join(root, "linked");
  await mkdir(physical);
  await symlink(physical, linked, "dir");
  const id = crypto.randomUUID();
  const manager = SessionManager.create(physical, join(physical, PI_SESSION_DIR), { id });
  manager.appendMessage({
    role: "user",
    content: "Preserve this native history",
    timestamp: Date.now(),
  });
  const store = await FilePiChatStore.open(linked);
  await store.save({
    id,
    title: "Linked chat",
    updatedAt: Date.now(),
    status: "idle",
    model: "test",
    requestIds: [crypto.randomUUID()],
  });
  return { root, linked, id, file: manager.getSessionFile()!, store };
}

test("reopening a symlink workspace retains its native transcript", async () => {
  const { root, linked, id } = await linkedSession();
  try {
    const reopened = await FilePiChatStore.open(linked);
    expect(await reopened.messages(id)).toMatchObject([
      { role: "user", text: "Preserve this native history" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removing a session through a symlink workspace deletes its native JSONL", async () => {
  const { root, id, file, store } = await linkedSession();
  try {
    expect(await Bun.file(file).exists()).toBe(true);
    await store.remove(id);
    expect(await Bun.file(file).exists()).toBe(false);
    expect(await store.list()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists session metadata, rejects path traversal, and preserves native transcripts on reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-store-"));
  try {
    const store = await FilePiChatStore.open(directory);
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
    expect(await (await FilePiChatStore.open(directory)).list()).toEqual([row]);
    expect(await store.messages(id)).toEqual([]);
    await expect(store.remove("../outside")).rejects.toThrow();
    await store.remove(id);
    expect(await (await FilePiChatStore.open(directory)).wasAccepted(row.requestIds[0]!)).toBe(
      true,
    );
    expect(await store.list()).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
