import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WEB_DRAFT_REVIEW_MARKER } from "#src/server/artifacts/artifact-notice-visibility.server";
import { AGENT_RECOVERY_MESSAGE_LIMIT } from "#src/server/db/repositories/agent-recovery-row.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");

test("the pending page keeps the attention rule and the notice permission, in order", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `pending-${suffix}`, username: `pending${suffix}` },
  });
  const otherUser = await db.user.create({
    data: { displayName: `other-${suffix}`, username: `other${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `pending-${suffix}`,
      name: "Pending page",
      members: { create: [{ userId: user.id }] },
    },
  });
  const otherWorkspace = await db.workspace.create({
    data: {
      slug: `pending-other-${suffix}`,
      name: "Other pending",
      members: { create: [{ userId: otherUser.id }] },
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
    });
    const sibling = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "sibling",
        displayName: "Sibling",
        runtimeConfig: {},
      },
    });
    const elsewhere = await db.agent.create({
      data: {
        workspaceId: otherWorkspace.id,
        ownerId: otherUser.id,
        name: "elsewhere",
        displayName: "Elsewhere",
        runtimeConfig: {},
      },
    });

    const plans = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `plans-${suffix}` },
    });
    const planner = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: plans.id, userId: user.id },
    });
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: plans.id, agentId: reader.id },
    });
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: plans.id, agentId: sibling.id },
    });

    const left = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `left-${suffix}` },
    });
    const leftMember = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: left.id, userId: user.id },
    });
    await db.conversationMember.create({
      data: {
        workspaceId: workspace.id,
        conversationId: left.id,
        agentId: reader.id,
        leftAt: new Date(),
      },
    });

    const dm = await db.conversation.create({
      data: { workspaceId: workspace.id, directKey: `user:${user.id}|agent:${reader.id}` },
    });
    const dmMember = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: dm.id, userId: user.id },
    });

    const announcements = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `announce-${suffix}` },
    });
    const announcer = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: announcements.id, userId: user.id },
    });

    const source = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `source-${suffix}` },
    });
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: source.id, userId: user.id },
    });
    const comments = await db.conversation.create({
      data: { workspaceId: workspace.id, kind: "attachment_comments" },
    });
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: comments.id, agentId: reader.id },
    });

    const otherChannel = await db.conversation.create({
      data: { workspaceId: otherWorkspace.id, channelName: `other-${suffix}` },
    });
    await db.conversationMember.create({
      data: {
        workspaceId: otherWorkspace.id,
        conversationId: otherChannel.id,
        userId: otherUser.id,
      },
    });
    await db.conversationMember.create({
      data: {
        workspaceId: otherWorkspace.id,
        conversationId: otherChannel.id,
        agentId: elsewhere.id,
      },
    });

    const readableArtifact = await db.artifact.create({
      data: {
        workspaceId: workspace.id,
        homeKey: `conversation:${plans.id}`,
        access: "workspace",
        name: `notice-${suffix}`,
        entryPath: "index.html",
      },
    });

    let step = 0;
    const clock = () => new Date(Date.parse("2024-01-01T00:00:00Z") + ++step * 1000);
    let sequence = 0;
    const seed = async (input: {
      conversationId: string;
      workspaceId?: string;
      agentId?: string;
      senderMemberId: string | null;
      receivedAt?: Date;
      expiresAt?: Date;
    }) => {
      const createdAt = clock();
      const message = await db.message.create({
        data: {
          conversationId: input.conversationId,
          workspaceId: input.workspaceId ?? workspace.id,
          body: `pending row ${step}`,
          sequence: ++sequence,
          senderMemberId: input.senderMemberId,
          createdAt,
        },
      });
      const delivery = await db.agentMessageDelivery.create({
        data: {
          messageId: message.id,
          workspaceId: input.workspaceId ?? workspace.id,
          conversationId: input.conversationId,
          agentId: input.agentId ?? reader.id,
          sequence: message.sequence,
          createdAt,
          receivedAt: input.receivedAt ?? null,
          expiresAt: input.expiresAt ?? null,
        },
      });
      return { messageId: message.id, deliveryId: delivery.deliveryId };
    };

    const attachments = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: source.id,
        objectKey: `pending/${suffix}/report.pdf`,
        fileName: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 12,
      },
    });
    await db.attachmentCommentThread.create({
      data: {
        attachmentId: attachments.id,
        workspaceId: workspace.id,
        conversationId: comments.id,
      },
    });

    const received = await seed({
      conversationId: plans.id,
      senderMemberId: planner.id,
      receivedAt: new Date(),
    });
    const stale = await seed({
      conversationId: plans.id,
      senderMemberId: planner.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const lostSeat = await seed({ conversationId: left.id, senderMemberId: leftMember.id });
    const siblingDelivery = await seed({
      conversationId: plans.id,
      senderMemberId: planner.id,
      agentId: sibling.id,
    });
    const foreign = await seed({
      conversationId: otherChannel.id,
      workspaceId: otherWorkspace.id,
      agentId: elsewhere.id,
      senderMemberId: null,
    });
    const unseatedComment = await seed({ conversationId: comments.id, senderMemberId: null });
    await db.attachmentComment.create({
      data: {
        messageId: unseatedComment.messageId,
        attachmentId: attachments.id,
        workspaceId: workspace.id,
        conversationId: comments.id,
      },
    });
    const blockedNotice = await seed({ conversationId: plans.id, senderMemberId: null });
    await db.systemAgentEvent.create({
      data: {
        source: "system.artifacts",
        agentId: reader.id,
        workspaceId: workspace.id,
        conversationId: plans.id,
        messageId: blockedNotice.messageId,
        externalEventId: `${crypto.randomUUID()}:${WEB_DRAFT_REVIEW_MARKER}:${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const readableNotice = await seed({ conversationId: plans.id, senderMemberId: null });
    await db.systemAgentEvent.create({
      data: {
        source: "system.artifacts",
        agentId: reader.id,
        workspaceId: workspace.id,
        conversationId: plans.id,
        messageId: readableNotice.messageId,
        externalEventId: `${readableArtifact.id}:${WEB_DRAFT_REVIEW_MARKER}:${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const channelMessage = await seed({ conversationId: plans.id, senderMemberId: planner.id });
    const unseatedDm = await seed({ conversationId: dm.id, senderMemberId: dmMember.id });
    const notifiedMention = await seed({
      conversationId: announcements.id,
      senderMemberId: announcer.id,
    });
    await db.pendingMentionAction.create({
      data: {
        messageId: notifiedMention.messageId,
        conversationId: announcements.id,
        workspaceId: workspace.id,
        senderMemberId: announcer.id,
        targetAgentId: reader.id,
        targetHandle: "reader",
        expiresAt: new Date(Date.now() + 86_400_000),
        notifiedAt: new Date(),
      },
    });

    const seeded = [
      received,
      stale,
      lostSeat,
      siblingDelivery,
      foreign,
      unseatedComment,
      blockedNotice,
      readableNotice,
      channelMessage,
      unseatedDm,
      notifiedMention,
    ];
    expect(new Set(seeded.map((row) => row.deliveryId)).size).toBe(seeded.length);

    const repository = new PrismaDirectConversationRepository(db);
    const actual = (await repository.readPendingAgentDeliveries(workspace.id, reader.id)).map(
      (delivery) => delivery.deliveryId,
    );

    expect(actual).toEqual([
      readableNotice.deliveryId,
      channelMessage.deliveryId,
      unseatedDm.deliveryId,
      notifiedMention.deliveryId,
    ]);

    const chosen = {
      deliveryIds: [
        received.deliveryId,
        stale.deliveryId,
        blockedNotice.deliveryId,
        readableNotice.deliveryId,
      ],
    };
    const chosenIds = (
      await repository.readPendingAgentDeliveries(workspace.id, reader.id, chosen)
    ).map((delivery) => delivery.deliveryId);
    expect(chosenIds).toEqual([received.deliveryId, readableNotice.deliveryId]);

    const withUnreceived = { ...chosen, orUnreceived: true };
    const unionIds = (
      await repository.readPendingAgentDeliveries(workspace.id, reader.id, withUnreceived)
    ).map((delivery) => delivery.deliveryId);
    expect(unionIds).toEqual([received.deliveryId, ...actual]);

    expect(
      await repository.readPendingAgentDeliveries(workspace.id, reader.id, { deliveryIds: [] }),
    ).toEqual([]);
  } finally {
    await db.workspace.deleteMany({
      where: { id: { in: [workspace.id, otherWorkspace.id] } },
    });
    await db.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } });
    await db.$disconnect();
  }
});

test("a blocked notice no longer costs the page a row", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `cap-${suffix}`, username: `cap${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `cap-${suffix}`,
      name: "Pending cap",
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
    });
    const channel = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `cap-${suffix}` },
    });
    const sender = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: channel.id, userId: user.id },
    });
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: channel.id, agentId: reader.id },
    });

    const base = Date.parse("2024-01-01T00:00:00Z");
    const blockedCount = 5;
    const blockedRows = Array.from({ length: blockedCount }, (_, index) => ({
      sequence: 1 + index,
      createdAt: new Date(base + index * 1000),
      body: `blocked ${index}`,
    }));
    const blockedMessages = await db.message.createManyAndReturn({
      data: blockedRows.map((row) => ({
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: null,
        body: row.body,
        sequence: row.sequence,
        createdAt: row.createdAt,
      })),
      select: { id: true, sequence: true },
    });
    await db.agentMessageDelivery.createMany({
      data: blockedMessages.map((message, index) => ({
        messageId: message.id,
        workspaceId: workspace.id,
        conversationId: channel.id,
        agentId: reader.id,
        sequence: message.sequence,
        createdAt: blockedRows[index]!.createdAt,
      })),
    });
    await db.systemAgentEvent.createMany({
      data: blockedMessages.map((message) => ({
        source: "system.artifacts",
        agentId: reader.id,
        workspaceId: workspace.id,
        conversationId: channel.id,
        messageId: message.id,
        externalEventId: `${crypto.randomUUID()}:${WEB_DRAFT_REVIEW_MARKER}:${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    });

    const allowedRows = Array.from({ length: AGENT_RECOVERY_MESSAGE_LIMIT }, (_, index) => ({
      sequence: blockedCount + 1 + index,
      createdAt: new Date(base + (blockedCount + index) * 1000),
    }));
    const allowedMessages = await db.message.createManyAndReturn({
      data: allowedRows.map((row) => ({
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: sender.id,
        body: `allowed ${row.sequence}`,
        sequence: row.sequence,
        createdAt: row.createdAt,
      })),
      select: { id: true, sequence: true },
    });

    await db.agentMessageDelivery.createMany({
      data: allowedMessages.map((message) => ({
        workspaceId: workspace.id,
        conversationId: channel.id,
        messageId: message.id,
        agentId: reader.id,
        sequence: message.sequence,
      })),
    });

    const repository = new PrismaDirectConversationRepository(db);
    const actual = (await repository.readPendingAgentDeliveries(workspace.id, reader.id)).map(
      (delivery) => delivery.messageId,
    );
    expect(actual).toEqual(allowedMessages.map((message) => message.id));
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }
});
