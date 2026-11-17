import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { silentRealtime } from "./helpers/workspace-member-leave-fixture";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { username: `reclaim-${suffix}`, displayName: "Reclaim" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `reclaim-${suffix}`,
      name: "Reclaim",
      members: { create: { userId: owner.id, role: "admin" } },
    },
  });
  const agent = await db.agent.create({
    data: {
      name: `claim-${suffix}`,
      displayName: "Claim agent",
      ownerId: owner.id,
      workspaceId: workspace.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channels = new PublicChannels(db, undefined, undefined, undefined, silentRealtime);
  const channel = await channels.create(workspace.id, owner.id, `reclaim-${suffix}`);
  await channels.addMembers(workspace.id, { userId: owner.id }, channel.id, {
    userIds: [],
    agentIds: [agent.id],
  });
  const memberRow = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId: channel.id, userId: owner.id } },
  });
  const agentRow = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_agentId: { conversationId: channel.id, agentId: agent.id } },
  });
  const message = await db.$transaction(async (tx) => {
    const sequence = await allocateSequence(tx, channel.id);
    return tx.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: channel.id,
        senderMemberId: memberRow.id,
        sequence,
        body: "the message the claim names",
      },
    });
  });
  return { owner, workspace, agent, channel, memberRow, agentRow, message };
}

test("an old task whose id is its message's still reads and writes", async () => {
  const f = await fixture();
  const board = new TaskBoard(db);
  const task = await db.task.create({
    data: {
      id: f.message.id,
      messageId: f.message.id,
      conversationId: f.channel.id,
      workspaceId: f.workspace.id,
      number: 1,
      title: "an old task",
      creatorMemberId: f.memberRow.id,
      ownerMemberId: f.agentRow.id,
    },
    select: { id: true, number: true },
  });
  const read = await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "list",
      conversationId: f.channel.id,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(read.tasks.some((t) => t.id === task.id)).toBe(true);
  await board.execute(
    { workspaceId: f.workspace.id, userId: f.owner.id },
    {
      operation: "update",
      conversationId: f.channel.id,
      number: task.number,
      status: "done",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(
    (await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).status,
  ).toBe("done");
});

test("a task's delete and restore publish under its own id", async () => {
  const f = await fixture();
  const publications: string[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      ...silentRealtime,
      taskChanged: async (signal) => {
        publications.push(signal.publicationId);
      },
    },
  });
  const principal = { workspaceId: f.workspace.id, userId: f.owner.id };
  const created = await board.execute(principal, {
    operation: "create",
    conversationId: f.channel.id,
    title: "deleted and restored",
    idempotencyKey: crypto.randomUUID(),
  });
  const { id, number } = created.tasks[0]!;
  for (const operation of ["delete", "restore"] as const)
    await board.execute(principal, {
      operation,
      conversationId: f.channel.id,
      number,
      idempotencyKey: crypto.randomUUID(),
    });
  expect(publications).toContain(`${id}:task-deleted`);
  expect(publications).toContain(`${id}:task-restored`);
});

afterAll(async () => {
  await db.$disconnect();
});
