import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

export async function taskAuthorizationFixture() {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const board = new TaskBoard(db);
  // Fixture messages take the next free sequence: Task writes also post server notices.
  const nextSequence = async (conversationId: string) =>
    ((
      await db.message.findFirst({
        where: { conversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      })
    )?.sequence ?? 0) + 1;
  const suffix = crypto.randomUUID();
  const short = suffix.slice(0, 8);
  const users = await Promise.all(
    ["alice", "bob", "mallory"].map((name) =>
      db.user.create({
        data: { displayName: `ta-${name}-${short}`, username: `ta-${name}-${short}` },
      }),
    ),
  );
  const [alice, bob, mallory] = users;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-auth-${suffix}`,
      name: "Task authorization",
      members: { create: [{ userId: alice!.id }, { userId: bob!.id }] },
      agents: {
        create: [
          {
            name: `task-auth-agent-${short}`,
            displayName: "Owned Agent",
            ownerId: alice!.id,
            runtimeConfig: {},
          },
          {
            name: `task-auth-peer-${short}`,
            displayName: "Peer Agent",
            ownerId: bob!.id,
            runtimeConfig: {},
          },
        ],
      },
    },
    include: { agents: true },
  });
  const [agent, peerAgent] = workspace.agents;
  const otherWorkspace = await db.workspace.create({
    data: {
      slug: `task-auth-other-${suffix}`,
      name: "Other workspace",
      members: { create: { userId: mallory!.id } },
    },
  });

  const publicChannel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `public-${short}`,
      members: {
        create: [{ userId: alice!.id }, { agentId: agent!.id }, { agentId: peerAgent!.id }],
      },
    },
    include: { members: true },
  });
  const otherChannel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `other-${short}`,
      members: { create: [{ userId: alice!.id }, { agentId: agent!.id }] },
    },
    include: { members: true },
  });
  const direct = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      directKey: [alice!.id, agent!.id].sort().join(":"),
      members: { create: [{ userId: alice!.id }, { agentId: agent!.id }] },
    },
    include: { members: true },
  });
  const aliceChannelMember = publicChannel.members.find((member) => member.userId === alice!.id)!;
  const aliceOtherMember = otherChannel.members.find((member) => member.userId === alice!.id)!;
  return {
    db,
    board,
    nextSequence,
    users,
    alice,
    bob,
    mallory,
    workspace,
    agent,
    peerAgent,
    otherWorkspace,
    publicChannel,
    otherChannel,
    direct,
    aliceChannelMember,
    aliceOtherMember,
  };
}
