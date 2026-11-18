import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentControlRevision } from "#src/server/agents/agent-control.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";

function database() {
  const connectionString = Bun.env.AGENT_SESSION_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("AGENT_SESSION_TEST_DATABASE_URL is required (local PostgreSQL)");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const storedConfig = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};

async function seedWorkspace(db: PrismaClient) {
  const fixture = crypto.randomUUID();
  const owner = await db.user.create({
    data: { displayName: `cand-${fixture}`, username: `cand-${fixture}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `cand-${fixture}`,
      name: "Candidates",
      members: { create: { userId: owner.id } },
    },
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: `cand-${fixture}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  return { owner, workspace, computer };
}

async function seedAgent(
  db: PrismaClient,
  base: Awaited<ReturnType<typeof seedWorkspace>>,
  name: string,
  controlState: Record<string, unknown> | null,
  deletedAt: Date | null = null,
) {
  const agent = await db.agent.create({
    data: {
      workspaceId: base.workspace.id,
      ownerId: base.owner.id,
      computerId: base.computer.id,
      name,
      displayName: name,
      runtimeConfig: storedConfig,
      deletedAt,
    },
  });
  if (controlState)
    await db.agent.update({
      where: { id: agent.id },
      data: {
        controlState: {
          version: 1,
          protocolMajor: 1,
          requestId: `r-${name}`,
          workspaceId: base.workspace.id,
          computerId: base.computer.id,
          agentId: agent.id,
          provider: "pi",
          epoch: 1,
          action: "start",
          configRevision: agentControlRevision(parseAgentRuntimeConfig(storedConfig)),
          launchId: "launch",
          controlSequence: 0,
          sessionSequence: 0,
          ...controlState,
        },
      },
    });
  return agent;
}

test("only starting Agents whose deadline has passed, or that never recorded one, are listed", async () => {
  const db = database();
  const base = await seedWorkspace(db);
  const NOW = 2_000_000_000_000;
  const expired = await seedAgent(db, base, "expired", {
    phase: "starting",
    deadlineAtMs: NOW - 1,
  });
  const atDeadline = await seedAgent(db, base, "at-deadline", {
    phase: "starting",
    deadlineAtMs: NOW,
  });
  const legacy = await seedAgent(db, base, "legacy", { phase: "starting" });
  const future = await seedAgent(db, base, "future", { phase: "starting", deadlineAtMs: NOW + 1 });
  const completed = await seedAgent(db, base, "completed", {
    phase: "completed",
    deadlineAtMs: NOW - 1,
  });
  const failed = await seedAgent(db, base, "failed", { phase: "failed", deadlineAtMs: NOW - 1 });
  const deleted = await seedAgent(
    db,
    base,
    "deleted",
    { phase: "starting", deadlineAtMs: NOW - 1 },
    new Date(),
  );
  const never = await seedAgent(db, base, "never", null);

  const found = new Set<string>();
  const store = new PrismaAgentControlStore(db);
  let cursor: Awaited<ReturnType<typeof store.listStartupCandidates>>["next"];
  do {
    const page = await store.listStartupCandidates(NOW, 1000, cursor);
    page.ids.forEach((id) => found.add(id));
    cursor = page.next;
  } while (cursor);

  expect(found.has(expired.id)).toBe(true);
  expect(found.has(atDeadline.id)).toBe(true);
  expect(found.has(legacy.id)).toBe(true);
  for (const agent of [future, completed, failed, deleted, never])
    expect(found.has(agent.id)).toBe(false);
});

test("a small batch walks every candidate exactly once through the cursor", async () => {
  const db = database();
  const base = await seedWorkspace(db);
  const NOW = 2_000_000_000_000;
  const seeded = new Set<string>();
  for (let index = 0; index < 5; index++) {
    const agent = await seedAgent(db, base, `walk-${index}`, {
      phase: "starting",
      deadlineAtMs: NOW - 10 + (index % 2),
    });
    seeded.add(agent.id);
  }
  const store = new PrismaAgentControlStore(db);
  const seen: string[] = [];
  let cursor: Awaited<ReturnType<typeof store.listStartupCandidates>>["next"];
  do {
    const page = await store.listStartupCandidates(NOW, 2, cursor);
    seen.push(...page.ids.filter((id) => seeded.has(id)));
    cursor = page.next;
  } while (cursor);
  expect(new Set(seen).size).toBe(5);
  expect(seen).toHaveLength(5);
});
