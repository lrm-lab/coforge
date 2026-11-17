import {
  APP_GRANT_AGENT_CARD_KIND,
  type AgentActionWithdrawResponse,
} from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { publishActionCardUpdate } from "./action-card-message.server";
import { effectiveActionCardState } from "./action-card-view.server";
import type { ConversationRealtime } from "./conversation-realtime.server";

/**
 * Retracts an unanswered Action Card (`pending → cancelled`, `committedByUserId: null`) prepared
 * by the calling Agent (`coforge action withdraw --message <id>`).
 *
 * - Another Agent's card, or a server-posted `app:grant_agent` card, is refused (`ACCESS_DENIED`).
 * - Withdrawing again when already cancelled by the Agent is idempotent (`alreadyWithdrawn: true`).
 * - An already-executed, expired, or human-cancelled card refuses with `CONFLICT`.
 * - Wakes nobody and publishes the existing `ConversationRealtime.messageAvailable` update.
 */
export async function withdrawActionCard(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  principal: { workspaceId: string; agentId: string },
  messageId: string,
): Promise<AgentActionWithdrawResponse> {
  const card = await db.actionCard.findUnique({
    where: { messageId },
    select: {
      messageId: true,
      conversationId: true,
      workspaceId: true,
      kind: true,
      state: true,
      expiresAt: true,
      committedByUserId: true,
      preparedByAgentId: true,
    },
  });
  if (!card || card.workspaceId !== principal.workspaceId) throw new AppError("NOT_FOUND");
  if (card.preparedByAgentId !== principal.agentId || card.kind === APP_GRANT_AGENT_CARD_KIND)
    throw new AppError("ACCESS_DENIED");
  if (card.state === "cancelled" && card.committedByUserId === null) {
    return {
      ok: true,
      messageId,
      state: "cancelled",
      alreadyWithdrawn: true,
    };
  }
  if (effectiveActionCardState(card.state, card.expiresAt) !== "pending")
    throw new AppError("CONFLICT");
  const updated = await db.actionCard.updateMany({
    where: { messageId, state: "pending" },
    data: { state: "cancelled", committedByUserId: null, committedAt: new Date() },
  });
  if (updated.count === 0) throw new AppError("CONFLICT");
  await publishActionCardUpdate(db, realtime, card.conversationId, messageId);
  return {
    ok: true,
    messageId,
    state: "cancelled",
  };
}
