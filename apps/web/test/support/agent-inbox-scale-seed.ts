import type { PrismaClient } from "#src/generated/prisma/client";
import { workspaceWithAgent } from "./agent-inbox-fixture";

export type ScaleInboxShape = {
  conversations: number;
  messagesPerConversation: number;
  threadsPerConversation: number;
  repliesPerThread: number;
};

const BASE = new Date(Date.UTC(2026, 9, 1));

export async function seedScaleInbox(db: PrismaClient, shape: ScaleInboxShape) {
  const suffix = crypto.randomUUID();
  const { owner, workspace, agent } = await workspaceWithAgent(db, suffix);
  const conversations = await db.conversation.createManyAndReturn({
    data: Array.from({ length: shape.conversations }, (_, index) => ({
      workspaceId: workspace.id,
      channelName: `bulk-${String(index).padStart(3, "0")}`,
    })),
  });
  const humans = await db.conversationMember.createManyAndReturn({
    data: conversations.map((conversation) => ({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      userId: owner.id,
    })),
  });
  const selves = await db.conversationMember.createManyAndReturn({
    data: conversations.map((conversation, index) => ({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      joinedAt: new Date(0),
      agentReadThroughSequence:
        index % 4 === 0 ? shape.messagesPerConversation : index % 2 === 0 ? 250 : 0,
    })),
  });
  const humanOf = new Map(humans.map((member) => [member.conversationId, member.id]));
  await db.$executeRaw`
    INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence, "createdAt")
    SELECT gen_random_uuid(), c.id, ${workspace.id}::uuid, c.human, 'm' || (g - 1), g,
           ${BASE}::timestamptz + (c.ord - 1) * interval '1 second' + (g - 1) * interval '1 millisecond'
    FROM unnest(${conversations.map((c) => c.id)}::uuid[], ${conversations.map((c) => humanOf.get(c.id)!)}::uuid[])
         WITH ORDINALITY AS c(id, human, ord)
    CROSS JOIN generate_series(1, ${shape.messagesPerConversation}) AS g`;

  const roots = await db.message.findMany({
    where: {
      sequence: { lte: shape.threadsPerConversation },
      conversationId: { in: conversations.map((c) => c.id) },
    },
    select: { id: true, conversationId: true, sequence: true },
  });
  const selfOf = new Map(selves.map((member) => [member.conversationId, member.id]));
  await db.threadFollow.createMany({
    data: roots.map((root) => ({
      memberId: selfOf.get(root.conversationId)!,
      rootMessageId: root.id,
      conversationId: root.conversationId,
      workspaceId: workspace.id,
    })),
  });
  await db.threadRead.createMany({
    data: roots
      .filter((root) => root.sequence % 2 === 0)
      .map((root) => ({
        memberId: selfOf.get(root.conversationId)!,
        rootMessageId: root.id,
        conversationId: root.conversationId,
        workspaceId: workspace.id,
        readThroughSequence: 10_000,
      })),
  });
  await db.$executeRaw`
    INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence, "threadRootId", "createdAt")
    SELECT gen_random_uuid(), root."conversationId", root."workspaceId", root."senderMemberId", 'r' || (r - 1),
           ${shape.messagesPerConversation} + (root.sequence - 1) * ${shape.repliesPerThread} + r, root.id,
           ${BASE}::timestamptz + interval '1000 seconds' + root.sequence * interval '1 second' + (r - 1) * interval '1 millisecond'
    FROM messages root
    CROSS JOIN generate_series(1, ${shape.repliesPerThread}) AS r
    WHERE root."workspaceId" = ${workspace.id}::uuid AND root."threadRootId" IS NULL
      AND root.sequence <= ${shape.threadsPerConversation}`;
  await db.$executeRawUnsafe(
    `ANALYZE conversations, conversation_members, messages, thread_follows, thread_reads`,
  );
  return { workspace, agent, followedThreads: roots.length };
}
