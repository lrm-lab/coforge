import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { TaskCommand, TaskPrincipal } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

test("a message whose Task was deleted can be claimed again", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const handle = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `reclaim-${handle}`, username: `reclaim-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `reclaim-${handle}`,
      name: "Reclaim",
      members: { create: [{ userId: alice.id, role: "owner" }] },
      agents: {
        create: [
          { name: `agent-${handle}`, displayName: "A", ownerId: alice.id, runtimeConfig: {} },
        ],
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `reclaim-${handle}`,
      members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
    },
    include: { members: true },
  });
  const sender = channel.members.find((member) => member.agentId === agent.id)!;
  const message = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: channel.id,
      senderMemberId: sender.id,
      body: "probe",
      sequence: 1,
    },
  });
  const board = new TaskBoard(db);
  const target = `#${channel.channelName}`;
  const asAgent: TaskPrincipal = { workspaceId: workspace.id, agentId: agent.id };
  const asAlice: TaskPrincipal = { workspaceId: workspace.id, userId: alice.id };
  const run = (principal: TaskPrincipal, command: Omit<TaskCommand, "idempotencyKey">) =>
    board.execute(principal, { idempotencyKey: crypto.randomUUID(), ...command });
  try {
    const first = await run(asAgent, { operation: "claim", target, messageId: message.id });
    expect(first.claims?.[0]?.success).toBe(true);
    const number = first.tasks[0]!.number;
    await run(asAlice, { operation: "delete", conversationId: channel.id, number });
    const again = await run(asAgent, { operation: "claim", target, messageId: message.id });
    expect(again.claims?.[0]?.success).toBe(true);
    expect(again.tasks[0]!.number).not.toBe(number);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: alice.id } }).catch(() => undefined);
    await db.$disconnect();
  }
});
