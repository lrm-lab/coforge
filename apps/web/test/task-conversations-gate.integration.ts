import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { deliveryFeatures } from "#src/server/conversations/agent-delivery-features.server";
import { taskConversationsGate } from "#src/server/tasks/task-conversations-gate.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId = "";
let slug = "";
let ownerId = "";
let agentId = "";

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `gate-owner-${suffix}`, displayName: "Owner" },
  });
  ownerId = owner.id;
  slug = `task-conv-gate-${suffix}`;
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "Gate",
      members: { create: { userId: owner.id, role: "member" } },
      agents: {
        create: { name: `gate-agent-${suffix}`, displayName: "A", ownerId, runtimeConfig: {} },
      },
    },
    include: { agents: true },
  });
  workspaceId = workspace.id;
  agentId = workspace.agents[0]!.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.$disconnect();
});

test("the Workspace's stored switch alone decides: no flag gates it anymore", async () => {
  const gate = taskConversationsGate(db, { workspaceId, agentId });
  const experiments = new PrismaExperimentsRepository(db);

  expect(await gate()).toBe(false); // nothing stored → the registry default, off
  await experiments.write(workspaceId, "taskConversations", true);
  expect(await gate()).toBe(true);
  await experiments.write(workspaceId, "taskConversations", false);
  expect(await gate()).toBe(false); // a stored off wins, flag or no flag

  expect(await taskConversationsGate(db, { workspaceId: crypto.randomUUID(), agentId })()).toBe(
    false,
  );
});

test("a delivery carries the same answer, and none when the Workspace cannot be read", async () => {
  const previous = Bun.env.DATABASE_URL;
  Bun.env.DATABASE_URL = connectionString;
  try {
    const experiments = new PrismaExperimentsRepository(db);
    await experiments.write(workspaceId, "taskConversations", true);
    expect(await deliveryFeatures(workspaceId)).toEqual({ taskConversations: true });
    await experiments.write(workspaceId, "taskConversations", false);
    expect(await deliveryFeatures(workspaceId)).toEqual({ taskConversations: false });
    Bun.env.DATABASE_URL = "";
    expect(await deliveryFeatures(workspaceId)).toBeUndefined();
  } finally {
    if (previous === undefined) delete Bun.env.DATABASE_URL;
    else Bun.env.DATABASE_URL = previous;
  }
});
