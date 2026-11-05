import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentContexts } from "#src/daemon-runtime/agent-contexts";
import type { AgentInput, AgentInputCompletion } from "#src/daemon-runtime/runtime-launch-intent";
import { captureDaemonLogs } from "./log-capture";

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function subject() {
  const root = await mkdtemp(join(tmpdir(), "coforge-contexts-compaction-"));
  roots.push(root);
  const workspace = join(root, "workspace-a", "agents", "agent-a");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "MEMORY.md"), "# Agent\n\n## Facts\n- one.\n", "utf8");
  const items: AgentInput[] = [];
  let stateDbOpened = false;
  const contexts = new AgentContexts(() => {
    stateDbOpened = true;
    throw new Error("the ledger must not open for a runtime that reports no compaction");
  });
  return { contexts, items, opened: () => stateDbOpened };
}

test("a finished compaction starts a new context and queues no memory input (task #548)", async () => {
  const { contexts, items } = await subject();
  const { records } = await captureDaemonLogs(async () => {
    contexts.newContext("agent-a");
  });
  expect(items).toEqual([]);
  expect(
    records.some((record) => record.properties.event === "agent.runtime.compaction_rebrief"),
  ).toBe(false);
});

test("the ledger stays off for a runtime that reports no compaction", async () => {
  const { contexts, opened } = await subject();
  contexts.newContext("agent-a", "cursor");
  expect(opened()).toBe(false);
  expect(contexts.ledger("agent-a")).toBeUndefined();
});
