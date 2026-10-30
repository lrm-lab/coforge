import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

test("an Agent that creates Tasks for itself gets the assignment receipt without a delivery", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const handle = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `self-alice-${handle}`, username: `self-alice-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `self-receipt-${handle}`,
      name: "Self-assignment receipt",
      members: { create: [{ userId: alice.id }] },
      agents: {
        create: {
          name: `self-agent-${handle}`,
          displayName: "Self Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  try {
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `self-receipt-${handle}`,
        members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
      },
    });
    const board = new TaskBoard(db, {
      realtime: { async memberChanged() {}, async messageAvailable() {} },
    });
    const batch = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        titles: ["batch one", "batch two"],
        assignee: `@${agent.name}`,
      },
    );
    expect(batch.assignmentReceipt).toMatchObject({
      state: "started",
      assignee: `@${agent.name}`,
    });
    expect(batch.assignmentReceipt!.messageId).not.toBe(batch.tasks[0]!.messageId);
    const assignmentMessage = await db.message.findUniqueOrThrow({
      where: { id: batch.assignmentReceipt!.messageId },
      include: { deliveries: true },
    });
    expect(assignmentMessage.senderMemberId).toBeNull();
    expect(assignmentMessage.body).toBe(batch.assignmentReceipt!.content);
    // An Agent that assigns itself already holds the receipt in its command result; delivering
    // it too would wake the Agent with its own action.
    expect(assignmentMessage.deliveries).toEqual([]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: alice.id } });
    await db.$disconnect();
  }
});
