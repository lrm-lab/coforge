import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAppInbox } from "#src/agent-app-inbox/agent-app-inbox";
import { LocalMemoryRuntime } from "#src/daemon-runtime/local-memory-runtime";
import { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import type { MemoryMeasurement } from "#src/system-cleaner/system-cleaner-measure";
import { ManualClock, config, OWNER, PLENTY_OF_DISK } from "./fixtures/system-cleaner-harness";

const roots: string[] = [];
afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function subject(enabled = true, measureKnowledgeSize?: () => Promise<MemoryMeasurement>) {
  const root = await mkdtemp(join(tmpdir(), "coforge-memory-maintenance-"));
  roots.push(root);
  const directory = join(root, "workspace/agents", OWNER);
  await mkdir(directory, { recursive: true });
  const inbox = await AgentAppInbox.open(root, "workspace", OWNER);
  const clock = new ManualClock();
  const wakes: string[] = [];
  const cleaner = new SystemCleaner({
    agentsDirectory: join(root, "workspace/agents"),
    clock,
    measureDiskSpace: async () => PLENTY_OF_DISK,
    measureKnowledgeSize,
    inbox: { upsert: (_, item) => inbox.upsert(item), remove: (_, id) => inbox.remove(id) },
    wake: async (_, itemId) => {
      wakes.push(itemId);
    },
  });
  cleaner.applyConfig(config({ enabled, thresholdBytes: 12_000 }));
  const memory = new LocalMemoryRuntime(
    () => OWNER,
    () => ({ workspaceRoot: root, workspaceId: "workspace" }),
    (agentId) => cleaner.onMemoryWrite(agentId),
  );
  const idle = async () => {
    cleaner.onAgentWorkingToIdle(OWNER);
    await cleaner.settled();
  };
  const save = (key: string, content = "verified ".repeat(1_400)) =>
    memory.execute(
      "context",
      {
        operation: "save",
        key,
        revision: "new",
        title: key,
        content,
        source: "Human-confirmed decision",
        kind: "decision",
        applicability: "staging",
      },
      "key",
    );
  return { root, directory, inbox, cleaner, memory, clock, wakes, idle, save };
}

test("successful writes defer a knowledge pressure hint to idle and keep full sourced entries", async () => {
  const s = await subject();
  for (let i = 0; i < 12; i++) await s.save(`decision-${i}`);
  await s.cleaner.settled();
  expect(await s.inbox.list()).toHaveLength(0);
  expect(s.wakes).toHaveLength(0);
  await s.idle();
  const hint = (await s.inbox.list()).find((item) => item.notificationClass === "knowledge_size");
  expect(hint?.command).toBe("coforge manual get memory");
  expect(hint?.summary).toContain("at most 5");
  expect(hint?.summary).toContain("history");
  expect(s.wakes).toHaveLength(1);
  const stored = await readFile(join(s.directory, "notes/knowledge/decision-0.md"), "utf8");
  expect(stored).toContain("verified ".repeat(1_400));
  expect(stored).toContain("Human-confirmed decision");
});

test("an idle boundary arriving during a slow inspection retains its later write check", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<MemoryMeasurement>();
  let reads = 0;
  const s = await subject(true, async () => {
    if (++reads === 1) {
      entered.resolve();
      return release.promise;
    }
    return { kind: "measured", bytes: 1_000_000 };
  });
  await s.save("first", "first fact");
  s.cleaner.onAgentWorkingToIdle(OWNER);
  await entered.promise;
  try {
    await s.save("second", "second fact");
    s.cleaner.onAgentWorkingToIdle(OWNER);
  } finally {
    release.resolve({ kind: "measured", bytes: 1 });
  }
  await s.cleaner.settled();
  expect(reads).toBe(3);
  expect(s.wakes).toHaveLength(1);
  expect((await s.inbox.list()).some((item) => item.notificationClass === "knowledge_size")).toBe(
    true,
  );
});

test("disabling while a write-triggered inspection waits fences off the old result", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<MemoryMeasurement>();
  const s = await subject(true, async () => {
    entered.resolve();
    return release.promise;
  });
  await s.save("first", "a fact");
  s.cleaner.onAgentWorkingToIdle(OWNER);
  await entered.promise;
  try {
    s.cleaner.applyConfig(config({ revision: 2, enabled: false }));
  } finally {
    release.resolve({ kind: "measured", bytes: 1_000_000 });
  }
  await s.cleaner.settled();
  expect(await s.inbox.list()).toHaveLength(0);
  expect(s.wakes).toHaveLength(0);
});

test("a partial scan without observed active pressure does not ask to archive more memories", async () => {
  const s = await subject(true, async () => ({ kind: "measured", bytes: 0, incomplete: true }));
  await s.save("small", "a small fact");
  await s.idle();
  expect((await s.inbox.list()).some((item) => item.notificationClass === "knowledge_size")).toBe(
    false,
  );
  expect(s.wakes).toHaveLength(0);
});

test("read calls and failed writes do not request maintenance; disabled cleaner stays silent", async () => {
  const s = await subject(false);
  for (let i = 0; i < 12; i++) await s.save(`decision-${i}`);
  await s.idle();
  expect(await s.inbox.list()).toHaveLength(0);
  s.cleaner.applyConfig(config({ revision: 2, thresholdBytes: 12_000 }));
  await s.memory.execute("context", { operation: "get", key: "decision-0" }, "key");
  await expect(s.save("decision-0")).rejects.toThrow("memory_conflict");
  await s.idle();
  expect(await s.inbox.list()).toHaveLength(0);
  await s.save("another");
  await s.idle();
  expect((await s.inbox.list()).some((item) => item.notificationClass === "knowledge_size")).toBe(
    true,
  );
});

test("repeated writes respect the cooldown and archiving clears pressure without deleting history", async () => {
  const s = await subject();
  const entries = [];
  for (let i = 0; i < 12; i++) entries.push((await s.save(`decision-${i}`)).entries[0]!);
  await s.idle();
  const firstWakes = s.wakes.length;
  expect(firstWakes).toBe(1);
  await s.save("small", "a small fact");
  await s.idle();
  expect(s.wakes).toHaveLength(firstWakes);
  for (const entry of entries)
    await s.memory.execute(
      "context",
      {
        operation: "archive",
        key: entry.key,
        revision: entry.revision,
      },
      "key",
    );
  await s.idle();
  expect((await s.inbox.list()).some((item) => item.notificationClass === "knowledge_size")).toBe(
    false,
  );
  const history = await s.memory.execute(
    "context",
    { operation: "history", key: "decision-0" },
    "key",
  );
  expect(history.entries[0]?.source).toBe("Human-confirmed decision");
  expect(history.entries[0]?.status).toBe("active");
});
