import type { ChoiceAction, ResolvedChoicePayload } from "@lrm/coforge-sdk/agent";
import type { ActionCardView, ActionCardViewBase } from "./action-card-view.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { publishActionCardUpdate } from "./action-card-message.server";
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
  return result;
}
