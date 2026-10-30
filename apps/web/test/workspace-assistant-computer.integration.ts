import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppErrorCode } from "#src/lib/app-error";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID();
let workspace: { id: string };
const noCluster = async () => undefined;

async function member(name: string) {
  const user = await db.user.create({
    data: { username: `assistant-computer-${name}-${suffix}`, displayName: name },
  });
  await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: user.id } });
  return user;
}

async function localComputer(ownerId: string, label: string) {
  return db.computer.create({
    data: {
      ownerId,
      machineId: `${label}-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
}

async function sendTo(userId: string, start: () => Promise<unknown>) {
  const assistants = new WorkspaceAssistants(db);
  const { agentId, conversationId } = await assistants.ensure(workspace.id, userId);
  await assistants.prepareConversation(workspace.id, userId, conversationId, start);
  return db.agent.findUniqueOrThrow({ where: { id: agentId }, select: { computerId: true } });
}

beforeAll(async () => {
  workspace = await db.workspace.create({
    data: { slug: `assistant-computer-${suffix}`, name: "Assistant computer" },
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspace.id } });
  await db.$disconnect();
});

test("without a cloud cluster the assistant runs on the oldest Computer its user owns here", async () => {
  const user = await member("own");
  const first = await localComputer(user.id, "first");
  await localComputer(user.id, "second");
  const other = await member("other");
  await localComputer(other.id, "not-mine");
  expect((await sendTo(user.id, noCluster)).computerId).toBe(first.id);
  // A later send keeps it: the choice never flips between sends.
  expect((await sendTo(user.id, noCluster)).computerId).toBe(first.id);
});

test("without a cloud cluster or a local Computer the send says to connect one", async () => {
  const user = await member("none");
  await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `extra-${suffix}`,
      kind: "cloud",
      cloudSlot: "extra",
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const error = await sendTo(user.id, noCluster).catch((cause: unknown) => cause);
  expect(isAppErrorCode(error, "TEMPORARILY_UNAVAILABLE")).toBe(true);
  expect((error as { errorId?: string }).errorId).toBe("workspace-assistant-computer-required");
});

test("a cloud computer that starts is preferred over the user's own", async () => {
  const user = await member("cloud");
  await localComputer(user.id, "laptop");
  const cloud = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `cloud-${suffix}`,
      kind: "cloud",
      cloudSlot: "default",
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const assistants = new WorkspaceAssistants(db);
  const { agentId, conversationId } = await assistants.ensure(workspace.id, user.id);
  await db.agent.update({ where: { id: agentId }, data: { computerId: null } });
  await assistants.prepareConversation(workspace.id, user.id, conversationId, async () => ({
    slot: "default",
    computerId: cloud.id,
  }));
  expect(
    (await db.agent.findUniqueOrThrow({ where: { id: agentId }, select: { computerId: true } }))
      .computerId,
  ).toBe(cloud.id);
});
