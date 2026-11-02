import type { ChoiceAction, ResolvedChoicePayload } from "@lrm/coforge-sdk/agent";
import type { ActionCardView, ActionCardViewBase } from "./action-card-view.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { publishActionCardUpdate } from "./action-card-message.server";
import { AgentDeliveryPublisher } from "./agent-delivery.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { loadPendingActionCard } from "./pending-action-card.server";

export function resolveChoicePayload(action: ChoiceAction): ResolvedChoicePayload {
  return {
    type: "choice",
    prompt: action.prompt,
    options: action.options.map((option) => ({ id: option.id, label: option.label })),
    allowFreeText: action.allowFreeText,
  };
}

export function choiceActionCardView(
  base: ActionCardViewBase,
  card: { preparedByAgent: { ownerId: string }; result: unknown },
  payload: ResolvedChoicePayload,
  viewerUserId: string,
  pending: boolean,
): ActionCardView {
  return {
    ...base,
    kind: "choice",
    prompt: payload.prompt,
    options: payload.options,
    allowFreeText: payload.allowFreeText,
    canCommit: pending && card.preparedByAgent.ownerId === viewerUserId,
    result: card.result as { optionId: string; label: string } | undefined,
  };
}

/** Records which option the person clicked. Free-text replies do not commit the card. */
export async function commitChoiceCard(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  principal: { workspaceId: string; actorUserId: string },
  input: { messageId: string; optionId: string },
  dependencies: { publisher?: Pick<CentrifugoServerApi, "publishBatch"> } = {},
): Promise<{ optionId: string; label: string }> {
  const card = await loadPendingActionCard(
    db,
    principal.workspaceId,
    principal.actorUserId,
    input.messageId,
    "choice",
  );
  if (card.preparedByAgent.ownerId !== principal.actorUserId) throw new AppError("ACCESS_DENIED");
  const payload = card.payload as ResolvedChoicePayload;
  const option = payload.options.find((entry) => entry.id === input.optionId);
  if (!option) throw new AppError("INVALID_INPUT");
  const result = { optionId: option.id, label: option.label };
  const updated = await db.actionCard.updateMany({
    where: { messageId: input.messageId, state: "pending" },
    data: {
      state: "executed",
      committedByUserId: principal.actorUserId,
      committedAt: new Date(),
      result: result as unknown as Prisma.InputJsonValue,
    },
  });
  if (updated.count === 0) throw new AppError("CONFLICT");
  await publishActionCardUpdate(db, realtime, card.conversationId, input.messageId);
  await wakeAskingAgent(db, dependencies.publisher, {
    workspaceId: principal.workspaceId,
    messageId: input.messageId,
    conversationId: card.conversationId,
    agentId: card.preparedByAgentId,
    prompt: payload.prompt,
    option,
  });
  return result;
}

/** The choice is a delivery: the Agent that asked is woken with the chosen label, and it does not
 * have to read the card back. No message is posted for the person. */
async function wakeAskingAgent(
  db: PrismaClient,
  publisher: Pick<CentrifugoServerApi, "publishBatch"> | undefined,
  input: {
    workspaceId: string;
    messageId: string;
    conversationId: string;
    agentId: string;
    prompt: string;
    option: { id: string; label: string };
  },
) {
  const [message, agent] = await Promise.all([
    db.message.findUnique({
      where: { id: input.messageId },
      select: {
        id: true,
        sequence: true,
        threadRootId: true,
        conversation: { select: { channelName: true } },
      },
    }),
    db.agent.findUnique({
      where: { id: input.agentId },
      select: { computerId: true },
    }),
  ]);
  if (!message) return;
  // The Agent's own card message has no delivery; an existing one means another path wrote it,
  // which must fail loudly rather than have its reason overwritten.
  const delivery = await db.agentMessageDelivery.create({
    data: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      messageId: input.messageId,
      sequence: message.sequence,
      reason: "choice",
    },
    select: { deliveryId: true, createdAt: true },
  });
  const target = `#${message.conversation.channelName ?? input.conversationId}${message.threadRootId ? `:${message.threadRootId}` : ""}`;
  await new AgentDeliveryPublisher(publisher ?? createCentrifugoServerApi()).publish(
    input.workspaceId,
    [
      {
        computerId: agent?.computerId ?? null,
        requestId: input.messageId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        messageId: input.messageId,
        deliveryId: delivery.deliveryId,
        sequence: message.sequence,
        createdAtMs: delivery.createdAt.getTime(),
        body: `Choice "${input.prompt}" in ${target}: chose ${input.option.id} · ${input.option.label}`,
        mentions: [],
        target,
        latestSenderKind: "system",
        latestSenderHandle: "",
        latestSenderDescription: "",
      },
    ],
  );
}
