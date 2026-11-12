import type { PrismaClient } from "#src/generated/prisma/client";
import {
  TARGET_CONVERSATION_SELECT,
  conversationTarget,
  deliveryTarget,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import { AgentDeliveryPublisher, agentDeliveryPush } from "./agent-delivery.server";

/**
 * Wakes the Agent that prepared a card with a system notice about its outcome. The delivery row
 * is written first and must fail loudly on an existing one (the Agent's own card message has no
 * delivery; another path having written it must not have its reason overwritten); the push is
 * skipped without a publisher, and the replay still carries the row. `choice` marks a card
 * someone answered or declined, `expired` one nobody answered — both are card events to the daemon.
 */
export async function wakeCardAuthor(
  db: PrismaClient,
  publisher: AgentDeliveryPublisher | undefined,
  card: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    preparedByAgentId: string;
  },
  reason: "choice" | "expired",
  body: (target: string) => string,
) {
  const [message, agent] = await Promise.all([
    db.message.findUnique({
      where: { id: card.messageId },
      select: {
        id: true,
        sequence: true,
        threadRootId: true,
        conversation: { select: TARGET_CONVERSATION_SELECT },
      },
    }),
    db.agent.findUnique({ where: { id: card.preparedByAgentId }, select: { computerId: true } }),
  ]);
  if (!message) return;
  const delivery = await db.agentMessageDelivery.create({
    data: {
      workspaceId: card.workspaceId,
      conversationId: card.conversationId,
      agentId: card.preparedByAgentId,
      messageId: card.messageId,
      sequence: message.sequence,
      reason,
    },
    select: { deliveryId: true, createdAt: true, reason: true },
  });
  const targetOf = await directTargets(db, card.workspaceId, card.preparedByAgentId, [
    message.conversation,
  ]);
  const target = deliveryTarget(
    conversationTarget(message.conversation, targetOf),
    message.threadRootId,
  );
  if (!publisher) return;
  await publisher.publish(card.workspaceId, [
    agentDeliveryPush({
      computerId: agent?.computerId ?? null,
      requestId: card.messageId,
      conversationId: card.conversationId,
      agentId: card.preparedByAgentId,
      messageId: card.messageId,
      deliveryId: delivery.deliveryId,
      sequence: message.sequence,
      reason: delivery.reason,
      createdAtMs: delivery.createdAt.getTime(),
      body: body(target),
      mentions: [],
      target,
      latestSenderKind: "system",
      latestSenderHandle: "",
      latestSenderDescription: "",
    }),
  ]);
}
