import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachSessionMemory,
  prependSessionMemory,
  rebriefAfterCompaction,
} from "#src/agent-runtime/session-memory-briefing";
import { agentStartupInput } from "#src/agent-runtime/agent-startup";
import { STARTUP_MEMORY_BLOCK_BUDGET_TOKENS } from "#src/agent-runtime/startup-memory-block";
import type { AgentInput, AgentInputQueue } from "#src/daemon-runtime/runtime-launch-intent";

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function workspace(memory: string | undefined) {
  const root = await mkdtemp(join(tmpdir(), "coforge-memory-briefing-"));
  roots.push(root);
  if (memory !== undefined) await writeFile(join(root, "MEMORY.md"), memory, "utf8");
  return root;
}

function queue(...items: AgentInput[]): AgentInputQueue {
  return { items, closed: false };
}

const completion = () => ({ resolve: () => {}, reject: () => {} });
const starter = (memoryInContext = false): AgentInput => ({
  kind: "startup",
  text: agentStartupInput(false, memoryInContext),
  completion: completion(),
});
const delivery = (): AgentInput => ({
  kind: "delivery",
  message: { deliveryId: "delivery-1", messageId: "message-1" } as never,
  completion: completion(),
});

test("an empty queue's starter carries the block and stops asking for MEMORY.md", async () => {
  const directory = await workspace("# Agent\n\n## Role\nRuns the runtime adapters.\n");
  const items = queue(starter());
  const block = await attachSessionMemory(items, directory);
  expect(block?.complete).toBe(true);
  expect(items.items).toHaveLength(1);
  const text = (items.items[0] as { text: string }).text;
  expect(text.startsWith("<memory-index")).toBe(true);
  expect(text).toContain("Runs the runtime adapters.");
  expect(text).toContain("You are starting a fresh session.");
  expect(text).not.toContain("read MEMORY.md and");
});

test("a truncated block tells the starter to read the rest of the file", async () => {
  const directory = await workspace(
    `# Agent\n\n${"filler line for the budget\n".repeat(STARTUP_MEMORY_BLOCK_BUDGET_TOKENS)}\n# END\n`,
  );
  const items = queue(starter());
  const block = await attachSessionMemory(items, directory);
  expect(block?.complete).toBe(false);
  const text = (items.items[0] as { text: string }).text;
  expect(text).toContain('shown="first');
  expect(text).toContain("read MEMORY.md and notes/active-context.md");
});

test("a queued delivery keeps its place behind one short reference turn", async () => {
  const directory = await workspace("# Agent\n\n## Role\nRuns the runtime adapters.\n");
  const items = queue(starter(), delivery());
  await attachSessionMemory(items, directory);
  expect(items.items).toHaveLength(3);
  const [memory, ...behind] = items.items as { kind: string; text?: string }[];
  expect(memory!.kind).toBe("memory");
  expect(memory!.text).toContain("<memory-index");
  expect(memory!.text).toContain("do not reply to it");
  expect(behind.map((item) => item.kind)).toEqual(["startup", "delivery"]);
});

test("nothing is injected without a file, for a closed queue, or a second pending block", async () => {
  const directory = await workspace(undefined);
  const missing = queue(starter());
  await attachSessionMemory(missing, directory);
  expect((missing.items[0] as { text: string }).text).not.toContain("<memory-index");

  const closed: AgentInputQueue = { items: [starter()], closed: true };
  expect(await attachSessionMemory(closed, directory)).toBeUndefined();
  expect((closed.items[0] as { text: string }).text).not.toContain("<memory-index");
});

function prependingQueue() {
  const items: string[] = [];
  return {
    items,
    waiting: () => items.length > 0,
    prepend: async (text: string) => {
      items.unshift(text);
    },
  };
}

test("a compaction queues one block ahead of the next input, and never a second", async () => {
  const directory = await workspace("# Agent\n\n## Role\nRuns the runtime adapters.\n");
  const items = prependingQueue();
  await rebriefAfterCompaction(items, "agent-a", directory);
  await rebriefAfterCompaction(items, "agent-a", directory);
  expect(items.items).toHaveLength(1);
  expect(items.items[0]).toContain("<memory-index");
  expect(items.items[0]).toContain("do not reply to it");
});

test("a compaction with no MEMORY.md queues nothing and does not throw", async () => {
  const directory = await workspace(undefined);
  const items = prependingQueue();
  await expect(rebriefAfterCompaction(items, "agent-a", directory)).resolves.toBeUndefined();
  expect(items.items).toHaveLength(0);
});
