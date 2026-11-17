import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { taskComputerRefusal } from "#src/server/tasks/task-computer-gate.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let ownerId = "";
let workspaceId = "";
const computers: Record<string, string> = {};
const agents: Record<string, string> = {};

beforeAll(async () => {
  const owner = await db.user.create({
    data: { username: `tcg-owner-${suffix}`, displayName: "Owner" },
  });
  ownerId = owner.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-computer-gate-${suffix}`,
      name: "Gate",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  for (const [key, version] of [
    ["old", "0.1.18"],
    ["new", "0.1.19-dev.3"],
  ] as const) {
    const computer = await db.computer.create({
      data: {
        ownerId,
        machineId: crypto.randomUUID(),
        name: `${key}-${suffix}`,
        displayName: `Studio ${key}`,
        computerVersion: version,
      },
    });
    computers[key] = computer.id;
    const agent = await db.agent.create({
      data: {
        workspaceId,
        ownerId,
        name: `tcg-${key}-${suffix}`,
        displayName: key,
        computerId: computer.id,
        runtimeConfig: {},
      },
    });
    agents[key] = agent.id;
  }
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.computer.deleteMany({ where: { id: { in: Object.values(computers) } } });
  await db.user.delete({ where: { id: ownerId } });
  await db.$disconnect();
});

test("an Agent on a Computer older than 0.1.19 is refused every Task request", async () => {
  const refusal = await taskComputerRefusal(db, { agentId: agents.old });
  expect(refusal?.status).toBe(426);
  expect(await refusal?.json()).toMatchObject({
    code: "CLIENT_UPGRADE_REQUIRED",
    retryable: false,
    error: expect.stringContaining("0.1.19"),
  });
  expect(await taskComputerRefusal(db, { agentId: agents.new })).toBeUndefined();
});

test("a Computer with an unknown version counts as older", async () => {
  await db.computer.update({ where: { id: computers.old }, data: { computerVersion: null } });
  expect((await taskComputerRefusal(db, { agentId: agents.old }))?.status).toBe(426);
});

test("once the Computer is current its Agent is no longer refused", async () => {
  await db.computer.update({ where: { id: computers.old }, data: { computerVersion: "0.1.19" } });
  expect(await taskComputerRefusal(db, { agentId: agents.old })).toBeUndefined();
});
