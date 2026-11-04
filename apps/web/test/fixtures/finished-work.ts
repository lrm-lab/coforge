import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * A Workspace with one channel (in a Project), a joined channel outside any Project, the viewer's
 * direct conversation with an Agent, a channel the viewer has not joined, and a direct
 * conversation the viewer is not part of. Each Task
 * is created through the board, then its status and last update are set as the case needs.
 */
export async function finishedWorkFixture() {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const board = new TaskBoard(db);
  const short = crypto.randomUUID().slice(0, 8);
  const [viewer, peer] = await Promise.all(
    ["viewer", "peer"].map((name) =>
      db.user.create({
        data: { displayName: `fin-${name}-${short}`, username: `fin-${name}-${short}` },
      }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-finished-${short}`,
      name: "Finished work",
      members: { create: [{ userId: viewer!.id }, { userId: peer!.id }] },
      agents: {
        create: [
          {
            name: `fin-agent-${short}`,
            displayName: "Viewer Agent",
            ownerId: viewer!.id,
            runtimeConfig: {},
          },
          {
            name: `fin-peer-agent-${short}`,
            displayName: "Peer Agent",
            ownerId: peer!.id,
            runtimeConfig: {},
          },
        ],
      },
    },
    include: { agents: true },
  });
  const viewerAgent = workspace.agents.find((agent) => agent.displayName === "Viewer Agent")!;
  const peerAgent = workspace.agents.find((agent) => agent.displayName === "Peer Agent")!;
  const project = await db.project.create({
    data: { workspaceId: workspace.id, name: "Launch", slug: `launch-${short}` },
  });
  const conversation = (data: { channelName?: string; userId: string; agentId?: string }) =>
    db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: data.channelName,
        directKey: data.agentId ? [data.userId, data.agentId].sort().join(":") : undefined,
        members: {
          create: [{ userId: data.userId }, ...(data.agentId ? [{ agentId: data.agentId }] : [])],
        },
      },
    });
  const channel = await conversation({
    channelName: `fin-${short}`,
    userId: viewer!.id,
  });
  // The peer joins the channel so a Task can be assigned to them.
  await db.conversationMember.create({
    data: { conversationId: channel.id, workspaceId: workspace.id, userId: peer!.id },
  });
  // A channel the viewer joined that belongs to no Project.
  const plain = await conversation({ channelName: `fin-plain-${short}`, userId: viewer!.id });
  const unjoined = await conversation({ channelName: `fin-unjoined-${short}`, userId: peer!.id });
  const ownDm = await conversation({ userId: viewer!.id, agentId: viewerAgent.id });
  const otherDm = await conversation({ userId: peer!.id, agentId: peerAgent.id });

  /** Creates a Task, then sets its status, owner and last update directly. */
  async function task(
    where: { id: string },
    creator: string,
    title: string,
    state: { status: string; daysAgo?: number; ownerUserId?: string; projectSlug?: string },
  ) {
    const created = await board.execute(
      { workspaceId: workspace.id, userId: creator },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: where.id,
        title,
        ...(state.projectSlug ? { project: state.projectSlug } : {}),
      },
    );
    const row = created.tasks[0]!;
    const owner = state.ownerUserId
      ? await db.conversationMember.findFirst({
          where: { conversationId: where.id, userId: state.ownerUserId },
          select: { id: true },
        })
      : null;
    const updatedAt = new Date(Date.now() - (state.daysAgo ?? 0) * 86_400_000);
    await db.$executeRaw`UPDATE tasks SET status = ${state.status}, "ownerMemberId" = ${owner?.id ?? null}::uuid, "updatedAt" = ${updatedAt} WHERE "messageId" = ${row.messageId}::uuid`;
    return row;
  }

  return {
    db,
    board,
    viewer: viewer!,
    peer: peer!,
    workspace,
    project,
    channel,
    plain,
    unjoined,
    ownDm,
    otherDm,
    task,
    async cleanup() {
      await db.workspace.deleteMany({ where: { id: workspace.id } });
      await db.user.deleteMany({ where: { id: { in: [viewer!.id, peer!.id] } } });
      await db.$disconnect();
    },
  };
}
