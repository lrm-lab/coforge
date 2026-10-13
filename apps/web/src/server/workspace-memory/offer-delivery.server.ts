import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";
import { createCentrifugoServerApi, daemonControlChannel } from "../centrifugo/server-api.server";
import { encodeAgentDelivery } from "../conversations/agent-delivery.server";
import { deliveryMentionsAgent } from "../conversations/mentions.server";

export type MemoryOfferPublisher = {
  publish(input: {
    workspaceId: string;
    conversationId: string;
    memoryAgentId: string;
    recipientAgentId: string;
    body: string;
    requestId: string;
  }): Promise<{ messageId: string }>;
};

export function createPrismaMemoryOfferPublisher(db: PrismaClient): MemoryOfferPublisher {
  const conversations = new PrismaDirectConversationRepository(db);
  return {
    async publish(input) {
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
      );
      // Push the recipient's delivery the way the send path does. Without this the
      // delivery row sits unreceived: agents are instructed never to poll, so the
      // recipient Agent is never woken and the offer dies unread.
      const publisher = createCentrifugoServerApi();
      await Promise.allSettled(
        saved.deliveries.flatMap((delivery) =>
          delivery.computerId
            ? [
                publisher.publish(
                  daemonControlChannel(input.workspaceId, delivery.computerId),
                  encodeAgentDelivery({
                    requestId: input.requestId,
                    workspaceId: input.workspaceId,
                    conversationId: input.conversationId,
                    agentId: delivery.agentId,
                    messageId: saved.id,
                    deliveryId: delivery.deliveryId,
                    sequence: saved.sequence,
                    body: saved.body,
                    mentions: saved.mentions ?? [],
                    target: saved.target,
                    latestSenderKind: saved.latestSenderKind,
                    latestSenderHandle: saved.latestSenderHandle,
                    latestSenderDescription: saved.latestSenderDescription,
                    mentionsAgent: deliveryMentionsAgent(saved.mentions ?? [], delivery.agentId),
                  }),
                ),
              ]
            : [],
        ),
      );
      return { messageId: saved.id };
    },
  };
}

export function createPrismaMemoryOfferChannels(db: PrismaClient) {
  return {
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
