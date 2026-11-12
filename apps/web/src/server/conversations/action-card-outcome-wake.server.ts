import type { PrismaClient } from "#src/generated/prisma/client";
import {
  TARGET_CONVERSATION_SELECT,
  conversationTarget,
  deliveryTarget,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { AgentDeliveryPublisher, agentDeliveryPush } from "./agent-delivery.server";
import { cardDeclinedBody, cardPerson } from "./action-card-outcome-body.server";

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

/**
 * The asked person declined the card: its Agent is told, so it can ask again or go on (Frank,
 * 11-12). Best-effort: a failed wake is logged and never fails the cancel that already settled the
 * card, and where no realtime publisher can be made the delivery row is still written for the
 * Agent's next replay.
 */
export async function wakeAgentOfDecline(
  db: PrismaClient,
  publisher: AgentDeliveryPublisher | undefined,
  card: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    kind: string;
    payload: unknown;
    preparedByAgentId: string;
    askedUserId: string;
  },
) {
  try {
    const decliner = await db.user.findUnique({
      where: { id: card.askedUserId },
      select: { username: true },
    });
    const prompt = (card.payload as { prompt?: string }).prompt;
    await wakeCardAuthor(db, publisher ?? defaultPublisher(), card, "choice", (target) =>
      cardDeclinedBody(cardPerson(decliner?.username), { kind: card.kind, prompt, target }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "action_card_decline_delivery_failed",
        messageId: card.messageId,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

/** The process's realtime publisher, or none where it cannot be made (no Centrifugo configured). */
function defaultPublisher() {
  try {
    return new AgentDeliveryPublisher(createCentrifugoServerApi());
  } catch {
    return undefined;
  }
}
