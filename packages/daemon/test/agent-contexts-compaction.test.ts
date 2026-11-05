import { afterAll, expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentContexts } from "#src/daemon-runtime/agent-contexts";
import type { AgentInput, AgentInputCompletion } from "#src/daemon-runtime/runtime-launch-intent";
import { captureDaemonLogs } from "./log-capture";

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

/** A runtime whose adapter declares no finished compaction still re-briefs on the event: the
 * re-brief hangs off the compaction phase, not off `reportsCompaction`, while the context ledger
 * (which would let a read drop text the Agent never saw again) stays off. */
test("a compaction event re-briefs a runtime that does not report compaction, without a ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-contexts-compaction-"));
  roots.push(root);
  const agentId = "agent-a";
  const workspace = join(root, "workspace-a", "agents", agentId);
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "MEMORY.md"),
    "# Agent\n\n## Facts\n- keeps its ports.\n",
    "utf8",
  );

  const items: AgentInput[] = [];
  const queue = { items, closed: false };
  let stateDbOpened = false;
  const contexts = new AgentContexts(
    () => {
      stateDbOpened = true;
      throw new Error("the ledger must not open for a runtime that reports no compaction");
    },
    () => ({
      connection: { workspaceRoot: root, workspaceId: "workspace-a" },
      inputDrain: {
        get: () => queue,
        prepend: (_agentId: string, build: (completion: AgentInputCompletion) => AgentInput) => {
          items.push(build({ resolve: () => {}, reject: () => {} }));
          return Promise.resolve();
        },
        ensure: () => {},
      } as never,
      session: () => ({}) as never,
    }),
  );

  // A launch names the runtime, which does not report compaction: no ledger for this Agent.
  contexts.newContext(agentId, "cursor");
  expect(stateDbOpened).toBe(false);
  expect(contexts.ledger(agentId)).toBeUndefined();

  // A finished compaction arrives anyway (the adapter maps `compaction_update`); it must re-brief.
  contexts.newContext(agentId);
  for (let i = 0; i < 100 && items.length === 0; i++) await Bun.sleep(10);
  expect(items).toHaveLength(1);
  expect(items[0]!.kind).toBe("memory");
  expect((items[0] as { text: string }).text).toContain("<memory-index");
  expect(stateDbOpened).toBe(false);
});

/** A workspace whose only input is the re-brief's own memory turn, and a ledger that must not open. */
async function quietSubject() {
  const root = await mkdtemp(join(tmpdir(), "coforge-contexts-guard-"));
  roots.push(root);
  const workspace = join(root, "workspace-a", "agents", "agent-a");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "MEMORY.md"), "# Agent\n\n## Facts\n- one.\n", "utf8");
  const items: AgentInput[] = [];
  const queue = { items, closed: false };
  const contexts = new AgentContexts(
    () => {
      throw new Error("the ledger must not open for a runtime that reports no compaction");
    },
    () => ({
      connection: { workspaceRoot: root, workspaceId: "workspace-a" },
      inputDrain: {
        get: () => queue,
        prepend: (_agentId: string, build: (completion: AgentInputCompletion) => AgentInput) => {
          items.push(build({ resolve: () => {}, reject: () => {} }));
          return Promise.resolve();
        },
        ensure: () => {},
      } as never,
      session: () => ({}) as never,
    }),
  );
  return { contexts, items };
}

test("a session that compacts again within the cooldown gets no second re-brief", async () => {
  const { contexts, items } = await quietSubject();
  const { records } = await captureDaemonLogs(async () => {
    contexts.newContext("agent-a");
    contexts.newContext("agent-a");
  });
  for (let i = 0; i < 100 && items.length < 1; i++) await Bun.sleep(5);
  expect(items).toHaveLength(1);
  expect(
    records.find(
      (record) => record.properties.event === "agent.runtime.compaction_rebrief_suppressed",
    )?.properties,
  ).toMatchObject({ agent_id: "agent-a", reason: "cooldown", consecutive: 1 });
});

test("consecutive re-briefs stop at the limit until the Agent launches again", async () => {
  jest.setSystemTime(new Date("2026-11-05T10:00:00.000Z"));
  try {
    const { contexts, items } = await quietSubject();
    const { records } = await captureDaemonLogs(async () => {
      for (let i = 0; i < 4; i++) {
        contexts.newContext("agent-a");
        jest.setSystemTime(Date.now() + 6 * 60_000);
      }
    });
    for (let i = 0; i < 100 && items.length < 3; i++) await Bun.sleep(5);
    expect(items).toHaveLength(3);
    expect(
      records.find(
        (record) => record.properties.event === "agent.runtime.compaction_rebrief_suppressed",
      )?.properties,
    ).toMatchObject({ agent_id: "agent-a", reason: "consecutive_limit", consecutive: 3 });
    // A launch is a new session: the next compaction may re-brief again. The earlier blocks were
    // consumed in the meantime, so the "one block queued at a time" guard is not what stops it.
    items.length = 0;
    contexts.newContext("agent-a", "cursor");
    contexts.newContext("agent-a");
    for (let i = 0; i < 100 && items.length < 1; i++) await Bun.sleep(5);
    expect(items).toHaveLength(1);
  } finally {
    jest.setSystemTime();
  }
});
