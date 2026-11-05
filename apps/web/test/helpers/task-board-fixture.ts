import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * The Workspace `tasks.integration.ts` runs its TaskBoard against, on local PostgreSQL: Alice and
 * Bob, an Agent on an attached Computer, a channel the three are in with one ordinary message of
 * Alice's to convert, a board that records what it announces, and Alice's direct conversation
 * with the Agent holding one attachment. The caller runs `cleanup` when it is done.
 */
export async function taskBoardFixture() {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const handle = suffix.slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `task-alice-${handle}`, username: `task-alice-${handle}` },
  });
  const bob = await db.user.create({
    data: { displayName: `task-bob-${handle}`, username: `task-bob-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `tasks-${suffix}`,
      name: "Tasks",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
      agents: {
        create: {
          name: `task-agent-${handle}`,
          displayName: "Task Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const computer = await db.computer.create({
    data: { ownerId: alice.id, machineId: crypto.randomUUID() },
  });
  await db.agent.update({
    where: { id: agent.id },
    data: { computerId: computer.id },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `tasks-${handle}`,
      members: {
        create: [{ userId: alice.id }, { userId: bob.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const aliceMember = channel.members.find((member) => member.userId === alice.id)!;
  const ordinary = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: channel.id,
      senderMemberId: aliceMember.id,
      sequence: 1,
      body: "Convert this message",
    },
  });
  const realtime: Array<{
    messageId: string;
    publicationId?: string;
    senderUserId?: string;
  }> = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable(event) {
        realtime.push(event);
      },
    },
  });
  const command = {
    operation: "create" as const,
    idempotencyKey: crypto.randomUUID(),
    conversationId: channel.id,
    title: "Ship Task backend",
  };
  /** Removes the Workspace (and every row in it), the Computer and both people. */
  const cleanup = async () => {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  };
  try {
    // Alice's direct conversation with the Agent, holding one uploaded attachment.
    const direct = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        directKey: [alice.id, agent.id].sort().join(":"),
        members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
      },
    });
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: direct.id,
        uploaderId: alice.id,
        objectKey: `tasks/${suffix}`,
        fileName: "task.txt",
        contentType: "text/plain",
        sizeBytes: 4,
      },
    });
    return {
      db,
      alice,
      bob,
      workspace,
      agent,
      channel,
      ordinary,
      realtime,
      board,
      command,
      direct,
      attachment,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
