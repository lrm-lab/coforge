import type { ActionCardKind } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ConversationHistory } from "./conversation-history.server";

/**
 * Require the Workspace, readable conversation, expected kind and pending state.
 * After the real operation, commit/cancel conditionally update pending; resource uniqueness
 * and addMembers skipDuplicates absorb races. This early check gives a friendly error.
 */
export async function loadPendingActionCard(
  db: PrismaClient,
  workspaceId: string,
  actorUserId: string,
  messageId: string,
  kind: ActionCardKind,
) {
  const card = await db.actionCard.findUnique({
    where: { messageId },
    select: {
      messageId: true,
      conversationId: true,
      workspaceId: true,
      kind: true,
      payload: true,
      state: true,
      preparedByAgent: { select: { ownerId: true } },
    },
  });
  if (!card || card.workspaceId !== workspaceId) throw new AppError("NOT_FOUND");
  await new ConversationHistory(db).authorize(workspaceId, actorUserId, card.conversationId);
  if (card.kind !== kind) throw new AppError("INVALID_INPUT");
  if (card.state !== "pending") throw new AppError("CONFLICT");
  return card;
}
