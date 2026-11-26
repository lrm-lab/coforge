import { afterEach, describe, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextViewStore } from "#src/agent-context-view/context-view-store";
import {
  openContextViewSourceAsync,
  readContextViewSourceAsync,
} from "#src/agent-context-view/context-view-source";
import {
  runContextViewRestoreChildMain,
  runContextViewRestoreFileInChild,
  runContextViewRestoreInChild,
} from "#src/agent-context-view/context-view-restore-runner";
import { applyContextViewGate } from "#src/daemon-runtime/context-view-runtime-wiring";
import { ImportantUnreadNoticeStore } from "#src/persistence/important-unread-notice-store";
import { FileAppNotifiedStore, type AppNotifiedStore } from "#src/persistence/app-notified-store";
import { AgentInboxCoordinator } from "#src/daemon-runtime/agent-inbox-coordinator";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("async context view source and streaming restore", () => {
  test("openContextViewSourceAsync and readContextViewSourceAsync enforce security rules", async () => {
    const root = tempDir("coforge-cv-async-");
    const outside = tempDir("coforge-cv-outside-");
    const file = join(root, "session.jsonl");
    writeFileSync(file, "hello", "utf8");
    const outsideFile = join(outside, "session.jsonl");
    writeFileSync(outsideFile, "hello", "utf8");
    const link = join(root, "link.jsonl");
    symlinkSync(file, link);
    const hardTarget = join(root, "hard-target.jsonl");
    writeFileSync(hardTarget, "hello", "utf8");
    const hard = join(root, "hard.jsonl");
    linkSync(hardTarget, hard);

    const okRead = await readContextViewSourceAsync(file, [root]);
    expect(okRead).toMatchObject({ ok: true, sourceBytes: 5 });
    expect(await readContextViewSourceAsync(outsideFile, [root])).toEqual({
      ok: false,
      failure: "outside_root",
    });
    expect(await readContextViewSourceAsync(link, [root])).toEqual({
      ok: false,
      failure: "unsafe",
    });
    expect(await readContextViewSourceAsync(hard, [root])).toEqual({
      ok: false,
      failure: "unsafe",
    });
    expect(await readContextViewSourceAsync(file, [root], 2)).toEqual({
      ok: false,
      failure: "too_large",
    });
    expect(await readContextViewSourceAsync(join(root, "missing.jsonl"), [root])).toEqual({
      ok: false,
      failure: "missing",
    });

    const opened = await openContextViewSourceAsync(file, [root]);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.size).toBe(5);
      await opened.handle.close();
    }
  });

  test("streams file to real restore child via v2 binary framing and supports legacy v1 JSON", async () => {
    const root = tempDir("coforge-cv-stream-");
    const file = join(root, "session.jsonl");
    const raw =
      [
        { type: "response_item", session_id: "s1", item: { type: "additional_tools", tools: [] } },
        { type: "user_message", session_id: "s1", message: "hello streaming" },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n";
    writeFileSync(file, raw, "utf8");

    const opened = await openContextViewSourceAsync(file, [root]);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const command = [
      process.execPath,
      join(import.meta.dir, "../../../packages/computer/src/main.ts"),
      "__restore-context-view",
    ];
    const streamed = await runContextViewRestoreFileInChild(
      {
        runtime: "codex",
        sessionId: "s1",
        messageId: "m1",
        handle: opened.handle,
        offset: opened.size,
        maxSourceBytes: opened.size + 1024,
      },
      { command },
    );
    expect(streamed.result.ok).toBe(true);
    expect(streamed.sourceBytes).toBe(Buffer.byteLength(raw, "utf8"));

    const oversized = await openContextViewSourceAsync(file, [root]);
    expect(oversized.ok).toBe(true);
    if (!oversized.ok) return;
    const limited = await runContextViewRestoreFileInChild(
      {
        runtime: "codex",
        sessionId: "s1",
        messageId: "m1",
        handle: oversized.handle,
        offset: oversized.size,
        maxSourceBytes: 10,
      },
      { command },
    );
    expect(limited.result).toEqual({
      ok: false,
      failure: "too_large",
      tooLargeCause: "session_file",
    });

    const v2Direct = await runContextViewRestoreInChild(
      {
        runtime: "codex",
        sessionId: "s1",
        messageId: "m1",
        buffer: Buffer.from(raw, "utf8"),
        offset: Buffer.byteLength(raw, "utf8"),
      },
      { command },
    );
    expect(v2Direct.ok).toBe(true);

    const legacyJson = JSON.stringify({
      runtime: "codex",
      sessionId: "s1",
      messageId: "m1",
      offset: Buffer.byteLength(raw, "utf8"),
      bufferBase64: Buffer.from(raw, "utf8").toString("base64"),
    });
    const outputChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      outputChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      async function* legacyStream() {
        yield Buffer.from(legacyJson, "utf8");
      }
      await runContextViewRestoreChildMain(legacyStream());
    } finally {
      process.stdout.write = origWrite;
    }
    expect(outputChunks.join("")).toContain('"outcome":"ok"');
  });
});

describe("ContextViewStore no-op compaction and gate deduplication", () => {
  test("compactWithStats skips rewriting index.jsonl when all entries are valid and retained", () => {
    const root = tempDir("coforge-cv-compact-noop-");
    const now = 10 * 24 * 60 * 60 * 1000;
    const store = new ContextViewStore(root, "server-1", "agent-1", () => now);
    store.record({
      messageId: "msg-1",
      sentAt: new Date(now - 2_000).toISOString(),
      runtime: "codex",
      sessionId: "s1",
      transcript: "native/s1.jsonl",
      offset: 10,
    });
    store.record({
      messageId: "msg-2",
      sentAt: new Date(now - 1_000).toISOString(),
      runtime: "codex",
      sessionId: "s1",
      transcript: "native/s1.jsonl",
      offset: 20,
    });
    const before = statSync(store.indexPath);
    expect(store.compactWithStats(30)).toEqual({ kept: 2, dropped: 0 });
    const after = statSync(store.indexPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("compactWithStats still rewrites index.jsonl to strip invalid lines", () => {
    const root = tempDir("coforge-cv-compact-corrupt-");
    const now = 10 * 24 * 60 * 60 * 1000;
    const store = new ContextViewStore(root, "server-1", "agent-1", () => now);
    const valid = JSON.stringify({
      messageId: "msg-1",
      sentAt: new Date(now - 1_000).toISOString(),
      runtime: "codex",
      sessionId: "s1",
      transcript: "native/s1.jsonl",
      offset: 10,
    });
    writeFileSync(store.indexPath, `${valid}\n{corrupt line\n`, "utf8");
    const before = statSync(store.indexPath);
    expect(store.compactWithStats(30)).toEqual({ kept: 1, dropped: 0 });
    const after = statSync(store.indexPath);
    expect(after.size).toBeLessThan(before.size);
  });

  test("applyContextViewGate skips redundant service enable and disable calls when unchanged", () => {
    let enableCalls = 0;
    let disableCalls = 0;
    const deps = {
      enabled: new Map<string, boolean>(),
      service: {
        enable: () => {
          enableCalls += 1;
        },
        disable: () => {
          disableCalls += 1;
        },
      } as never,
    };

    applyContextViewGate(deps, "agent-1", true);
    applyContextViewGate(deps, "agent-1", true);
    applyContextViewGate(deps, "agent-1", true);
    expect(enableCalls).toBe(1);
    expect(disableCalls).toBe(0);

    applyContextViewGate(deps, "agent-1", false);
    applyContextViewGate(deps, "agent-1", false);
    expect(enableCalls).toBe(1);
    expect(disableCalls).toBe(1);

    applyContextViewGate(deps, "agent-1", true);
    expect(enableCalls).toBe(2);
  });
});

describe("ImportantUnreadNoticeStore async coalescing", () => {
  test("coalesces back-to-back saves and clears asynchronously and flushes cleanly", async () => {
    const state = tempDir("coforge-unread-async-");
    const writer = new ImportantUnreadNoticeStore(() => state, "proc-a", { asyncWrites: true });
    const reader = new ImportantUnreadNoticeStore(() => state, "proc-b");
    const base = {
      agentId: "agent-1",
      key: "seq:1",
      highestSequence: 1,
      conversations: [{ conversationId: "c1", target: "#general", firstSequence: 1, count: 1 }],
      attempts: 0,
      writtenAtMs: 1_000,
    };

    writer.save(base);
    writer.save({ ...base, attempts: 1, nextAttemptAtMs: 61_000 });
    await writer.flush();
    expect(reader.list()).toEqual([{ ...base, attempts: 1, nextAttemptAtMs: 61_000 }]);

    writer.save({ ...base, highestSequence: 2, key: "seq:2" });
    writer.clear("agent-1");
    await writer.flush();
    expect(reader.list()).toEqual([]);

    writer.save({ ...base, highestSequence: 3, key: "seq:3" });
    writer.flushSync();
    expect(reader.list()).toEqual([{ ...base, highestSequence: 3, key: "seq:3" }]);
  });
});

describe("FileAppNotifiedStore cache and removeMany", () => {
  test("caches reads and prunes multiple items in one atomic write", async () => {
    const root = tempDir("coforge-app-notified-batch-");
    const store = new FileAppNotifiedStore(root, "ws-1");
    await store.add("agent-1", "session-1", ["i-1", "i-2", "i-3", "i-4"]);

    const filePath = join(root, "app-notified", "ws-1", "agent-1", "items.json");
    const before = statSync(filePath);
    expect([...(await store.read("agent-1", "session-1"))].sort()).toEqual([
      "i-1",
      "i-2",
      "i-3",
      "i-4",
    ]);

    await store.removeMany("agent-1", ["i-1", "i-2", "i-3"]);
    const after = statSync(filePath);
    expect(after.ino).not.toBe(before.ino);
    expect(await store.read("agent-1", "session-1")).toEqual(["i-4"]);

    const restarted = new FileAppNotifiedStore(root, "ws-1");
    expect(await restarted.read("agent-1", "session-1")).toEqual(["i-4"]);
  });

  test("InboxCoordinator.drainAppInboxNotices batches gone item removals via removeMany", async () => {
    const root = tempDir("coforge-drain-batch-");
    mkdirSync(root, { recursive: true });
    let removeCalls = 0;
    const removeManyBatches: string[][] = [];
    const notifiedAppItems: AppNotifiedStore = {
      read: async () => ["gone-1", "gone-2", "gone-3"],
      add: async () => {},
      remove: async () => {
        removeCalls += 1;
      },
      removeMany: async (_agentId, itemIds) => {
        removeManyBatches.push([...itemIds]);
      },
      clear: async () => {},
    };
    const coordinator = new AgentInboxCoordinator({
      workspaceId: "ws-1",
      stateDirectory: root,
      notifiedAppItems,
      consumedSeqs: {} as never,
      messageAttention: {} as never,
      deliveryGate: {} as never,
      runtimeRelease: {} as never,
      processManager: {
        restartConfig: () => ({ sessionId: "session-1" }),
        session: () => undefined,
      } as never,
      startAgent: async () => ({}) as never,
      currentActivityLaunch: () => undefined,
      reconcileIdleTurn: () => false,
      mentionDeliveries: {} as never,
      assertRunning: () => {},
      agentIdForContext: () => "agent-1",
    });

    await coordinator.drainAppInboxNotices("agent-1");
    expect(removeCalls).toBe(0);
    expect(removeManyBatches).toEqual([["gone-1", "gone-2", "gone-3"]]);
  });

  test("serializes cold-cache read behind concurrent add so writes are never lost", async () => {
    const root = tempDir("coforge-app-notified-race-");
    const store = new FileAppNotifiedStore(root, "ws-1");
    const [initialRead] = await Promise.all([
      store.read("agent-1", "session-1"),
      store.add("agent-1", "session-1", ["item-a"]),
    ]);
    expect(initialRead).toEqual([]);
    expect(await store.read("agent-1", "session-1")).toEqual(["item-a"]);
    await store.add("agent-1", "session-1", ["item-b"]);
    const restarted = new FileAppNotifiedStore(root, "ws-1");
    expect([...(await restarted.read("agent-1", "session-1"))].sort()).toEqual([
      "item-a",
      "item-b",
    ]);
  });
});

describe("review regression guards", () => {
  test("closes FileHandle when spawnRestoreChild throws synchronously", async () => {
    const root = tempDir("coforge-cv-spawn-throw-");
    const file = join(root, "session.jsonl");
    writeFileSync(file, "hello", "utf8");
    const opened = await openContextViewSourceAsync(file, [root]);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    let closed = false;
    const origClose = opened.handle.close.bind(opened.handle);
    opened.handle.close = async () => {
      closed = true;
      return origClose();
    };
    const outcome = await runContextViewRestoreFileInChild(
      {
        runtime: "codex",
        sessionId: "s1",
        messageId: "m1",
        handle: opened.handle,
        offset: 5,
      },
      { command: ["/nonexistent-coforge-binary-for-test"] },
    );
    expect(outcome.result).toEqual({ ok: false, failure: "read_failed" });
    expect(closed).toBe(true);
  });

  test("flushSync preserves latest state across in-flight async writes and tolerates invalid clear", async () => {
    const state = tempDir("coforge-unread-race-");
    const writer = new ImportantUnreadNoticeStore(() => state, "proc-a", { asyncWrites: true });
    const reader = new ImportantUnreadNoticeStore(() => state, "proc-b");
    const v1 = {
      agentId: "agent-1",
      key: "seq:1",
      highestSequence: 1,
      conversations: [{ conversationId: "c1", target: "#general", firstSequence: 1, count: 1 }],
      attempts: 0,
      writtenAtMs: 1_000,
    };
    const v2 = { ...v1, key: "seq:2", highestSequence: 2, attempts: 1 };

    writer.save(v1);
    await Promise.resolve();
    writer.save(v2);
    writer.flushSync();
    await writer.flush();
    expect(reader.list()).toEqual([v2]);

    writer.clear("../invalid-agent-id");
    await writer.flush();
    expect(reader.list()).toEqual([v2]);
  });
});
