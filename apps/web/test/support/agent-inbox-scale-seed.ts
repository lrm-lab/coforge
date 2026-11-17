import type { PrismaClient } from "#src/generated/prisma/client";
import { workspaceWithAgent } from "./agent-inbox-fixture";

export async function seedScaleInbox(
  db: PrismaClient,
  suffix: string,
  conversationCount: number,
  messagesPerConversation: number,
) {
  const { owner, workspace, agent } = await workspaceWithAgent(db, suffix);
  const conversations = await db.conversation.createManyAndReturn({
    data: Array.from({ length: conversationCount }, (_, index) => ({
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
      // Half the conversations are read up to the middle, a quarter fully.
      agentReadThroughSequence:
        index % 4 === 0 ? messagesPerConversation : index % 2 === 0 ? 250 : 0,
    })),
  });
  const humanOf = new Map(humans.map((member) => [member.conversationId, member.id]));
  const base = Date.UTC(2026, 9, 1);
  for (let start = 0; start < conversations.length; start += 20) {
    await db.message.createMany({
      data: conversations.slice(start, start + 20).flatMap((conversation, offset) =>
        Array.from({ length: messagesPerConversation }, (_, index) => ({
          conversationId: conversation.id,
          workspaceId: workspace.id,
          senderMemberId: humanOf.get(conversation.id)!,
          body: `m${index}`,
          sequence: index + 1,
          // Each conversation's latest message is a different second.
          createdAt: new Date(base + (start + offset) * 1000 + index),
        })),
      ),
    });
  }

  // Eight followed threads per conversation, three replies each; every other thread is read.
  const threadsPerConversation = 8;
  const repliesPerThread = 3;
  const roots = await db.message.findMany({
    where: {
      sequence: { lte: threadsPerConversation },
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
  for (let start = 0; start < roots.length; start += 800) {
    await db.message.createMany({
      data: roots.slice(start, start + 800).flatMap((root) =>
        Array.from({ length: repliesPerThread }, (_, index) => ({
          conversationId: root.conversationId,
          workspaceId: workspace.id,
          senderMemberId: humanOf.get(root.conversationId)!,
          body: `r${index}`,
          threadRootId: root.id,
          sequence: messagesPerConversation + (root.sequence - 1) * repliesPerThread + index + 1,
          createdAt: new Date(base + 1_000_000 + root.sequence * 1000 + index),
        })),
      ),
    });
  }
  return { workspace, agent, roots };
}
