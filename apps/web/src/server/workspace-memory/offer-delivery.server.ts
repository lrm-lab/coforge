import type { MemoryHintDelivery } from "@lrm/coforge-sdk/agent";
import { AgentDeliveryPublisher } from "#src/server/conversations/agent-delivery.server";
import { deliveryMentionsAgent } from "#src/server/conversations/mentions.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";

export type MemoryOfferPublisher = {
  publish(input: {
    workspaceId: string;
    conversationId: string;
    memoryAgentId: string;
    recipientAgentId: string;
    body: string;
    requestId: string;
    memoryHint: MemoryHintDelivery;
  }): Promise<{ messageId: string }>;
};

export function createPrismaMemoryOfferPublisher(db: PrismaClient): MemoryOfferPublisher {
  const conversations = new PrismaDirectConversationRepository(db);
  return {
    async publish(input) {
      const existing = await db.memoryHintRecord.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.memoryHint.hint_id } },
      });
      if (
        existing.targetAgentId !== input.recipientAgentId ||
        existing.memoryAgentId !== input.memoryAgentId
      )
        throw new Error("Memory Hint recipient mismatch");
      if (existing.messageId) return { messageId: existing.messageId };
      const recipient = await db.agent.findFirst({
        where: { id: input.recipientAgentId, workspaceId: input.workspaceId },
        select: { name: true },
      });
      if (!recipient) throw new Error("offer recipient is not an active workspace Agent");
      const mention = `@${recipient.name}`;
      const body = input.body.includes(mention) ? input.body : `${mention} ${input.body}`;
      const saved = await conversations.sendAgentMessage(
        input.conversationId,
        input.memoryAgentId,
        body,
        undefined,
        undefined,
        [{ type: "agent", id: input.recipientAgentId, name: recipient.name }],
        input.memoryHint.hint_id,
      );
      if (!saved.deliveries.some((delivery) => delivery.agentId === input.recipientAgentId))
        throw new Error("Memory Hint target delivery is missing");
      // Save exposure/receipt binding before waking the target. The body stays ordinary
      // channel content; only the recipient's structured delivery carries the receipt.
      await new AgentDeliveryPublisher(createCentrifugoServerApi()).publish(
        input.workspaceId,
        saved.deliveries.map((delivery) => ({
          ...delivery,
          requestId: input.requestId,
          conversationId: input.conversationId,
          messageId: saved.id,
          sequence: saved.sequence,
          body: saved.body,
          mentions: saved.mentions ?? [],
          target: saved.target,
          latestSenderKind: saved.latestSenderKind,
          latestSenderHandle: saved.latestSenderHandle,
          latestSenderDescription: saved.latestSenderDescription,
          mentionsAgent: deliveryMentionsAgent(saved.mentions ?? [], delivery.agentId),
          ...(delivery.agentId === input.recipientAgentId ? { memoryHint: input.memoryHint } : {}),
        })),
      );
      return { messageId: saved.id };
    },
  };
}

export function createPrismaMemoryOfferChannels(db: PrismaClient) {
  return {
    async isMemoryAgent(workspaceId: string, agentId: string): Promise<boolean> {
      return (
        (await db.openVikingMappedIdentity.findFirst({
          where: { workspaceId, actorKind: "memory_agent", actorSubject: agentId },
          select: { id: true },
        })) !== null
      );
    },
    async isActiveChannelAgent(
      workspaceId: string,
      conversationId: string,
      agentId: string,
    ): Promise<boolean> {
      const row = await db.conversationMember.findFirst({
        where: {
          workspaceId,
          conversationId,
          agentId,
          leftAt: null,
          conversation: { workspaceId, channelName: { not: null }, archivedAt: null },
        },
        select: { id: true },
      });
      return row !== null;
    },
  };
}
