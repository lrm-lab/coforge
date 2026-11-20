import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");

test("a task discussion reaches the pending page through its board and the reader's follow", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `thread-${suffix}`, username: `thread${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `thread-${suffix}`,
      name: "Task thread page",
      members: { create: [{ userId: user.id }] },
    },
  });
  try {
    const reader = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "reader",
        displayName: "Reader",
        runtimeConfig: {},
      },
      select: { id: true },
    });
    const board = (data: {
      channelName?: string;
      directKey?: string;
      visibility?: string;
      hidden?: boolean;
    }) =>
      db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: data.channelName ?? null,
          directKey: data.directKey ?? null,
          visibility: data.visibility ?? "public",
          hiddenFromWorkspaceAt: data.hidden ? new Date() : null,
        },
        select: { id: true },
      });
    const seat = (conversationId: string, actor: { userId: string } | { agentId: string }) =>
      db.conversationMember.create({
        data:
          "userId" in actor
            ? { workspaceId: workspace.id, conversationId, userId: actor.userId }
            : { workspaceId: workspace.id, conversationId, agentId: actor.agentId },
        select: { id: true },
      });
    let step = 0;
    const clock = () => new Date(Date.parse("2024-01-01T00:00:00Z") + ++step * 1000);
    const seedTaskDiscussion = async (input: {
      boardId: string;
      creatorMemberId: string;
      number: number;
      followerMemberId?: string;
    }) => {
      const discussion = await db.conversation.create({
        data: { workspaceId: workspace.id, kind: "task_thread" },
        select: { id: true },
      });
      const task = await db.task.create({
        data: {
          conversationId: input.boardId,
          workspaceId: workspace.id,
          number: input.number,
          title: `task ${input.number}`,
          creatorMemberId: input.creatorMemberId,
          discussionConversationId: discussion.id,
        },
        select: { id: true },
      });
      if (input.followerMemberId)
        await db.taskFollow.create({
          data: {
            taskId: task.id,
            memberId: input.followerMemberId,
            conversationId: input.boardId,
            workspaceId: workspace.id,
            reason: "manual",
          },
        });
      const createdAt = clock();
      const message = await db.message.create({
        data: {
          conversationId: discussion.id,
          workspaceId: workspace.id,
          body: `reply to task ${input.number}`,
          sequence: 1,
          createdAt,
        },
        select: { id: true },
      });
      const delivery = await db.agentMessageDelivery.create({
        data: {
          messageId: message.id,
          workspaceId: workspace.id,
          conversationId: discussion.id,
          agentId: reader.id,
          sequence: 1,
          createdAt,
        },
        select: { deliveryId: true },
      });
      return delivery.deliveryId;
    };

    const privateBoard = await board({ channelName: `private-${suffix}`, visibility: "private" });
    const privateCreator = await seat(privateBoard.id, { userId: user.id });
    const privateReaderSeat = await seat(privateBoard.id, { agentId: reader.id });
    const privateFollow = await seedTaskDiscussion({
      boardId: privateBoard.id,
      creatorMemberId: privateCreator.id,
      number: 1,
      followerMemberId: privateReaderSeat.id,
    });
    const privateNoFollow = await seedTaskDiscussion({
      boardId: privateBoard.id,
      creatorMemberId: privateCreator.id,
      number: 2,
    });

    const publicBoard = await board({ channelName: `public-${suffix}`, visibility: "public" });
    const publicCreator = await seat(publicBoard.id, { userId: user.id });
    const publicNoSeat = await seedTaskDiscussion({
      boardId: publicBoard.id,
      creatorMemberId: publicCreator.id,
      number: 1,
    });
    const publicReaderSeat = await seat(publicBoard.id, { agentId: reader.id });
    const publicFollow = await seedTaskDiscussion({
      boardId: publicBoard.id,
      creatorMemberId: publicCreator.id,
      number: 2,
      followerMemberId: publicReaderSeat.id,
    });

    const leftBoard = await board({ channelName: `left-${suffix}`, visibility: "public" });
    const leftCreator = await seat(leftBoard.id, { userId: user.id });
    const leftReaderSeat = await db.conversationMember.create({
      data: {
        workspaceId: workspace.id,
        conversationId: leftBoard.id,
        agentId: reader.id,
        leftAt: new Date(),
      },
      select: { id: true },
    });
    const leftFollow = await seedTaskDiscussion({
      boardId: leftBoard.id,
      creatorMemberId: leftCreator.id,
      number: 1,
      followerMemberId: leftReaderSeat.id,
    });

    const hiddenBoard = await board({
      channelName: `hidden-${suffix}`,
      visibility: "public",
      hidden: true,
    });
    const hiddenCreator = await seat(hiddenBoard.id, { userId: user.id });
    const hiddenReaderSeat = await seat(hiddenBoard.id, { agentId: reader.id });
    const hiddenFollow = await seedTaskDiscussion({
      boardId: hiddenBoard.id,
      creatorMemberId: hiddenCreator.id,
      number: 1,
      followerMemberId: hiddenReaderSeat.id,
    });

    const dmBoard = await board({ directKey: `user:${user.id}|agent:${reader.id}` });
    const dmCreator = await seat(dmBoard.id, { userId: user.id });
    const dmReaderSeat = await seat(dmBoard.id, { agentId: reader.id });
    const dmFollow = await seedTaskDiscussion({
      boardId: dmBoard.id,
      creatorMemberId: dmCreator.id,
      number: 1,
      followerMemberId: dmReaderSeat.id,
    });

    const seeded = [
      privateFollow,
      privateNoFollow,
      publicNoSeat,
      publicFollow,
      leftFollow,
      hiddenFollow,
      dmFollow,
    ];
    expect(new Set(seeded).size).toBe(seeded.length);
    expect(
      await db.agentMessageDelivery.count({
        where: { workspaceId: workspace.id, agentId: reader.id, receivedAt: null },
      }),
    ).toBe(seeded.length);

    const repository = new PrismaDirectConversationRepository(db);
    const actual = (await repository.readPendingAgentDeliveries(workspace.id, reader.id)).map(
      (delivery) => delivery.deliveryId,
    );

    expect(actual).toEqual([privateFollow, publicFollow, dmFollow]);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }
});
