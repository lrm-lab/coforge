import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { ActionCardKind, ResolvedActionCardPayload } from "@lrm/coforge-sdk/agent";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import type { ActionCardTarget } from "./action-card-target.server";
import { lockConversation } from "./conversation-lock.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { messageSignalScope } from "./conversation-signal-scope.server";
import { announceMessage } from "./conversation-activity.server";

/** Posts an action card in `tx`: the Agent's Message carrying `body`, and its `ActionCard` row,
 * under the conversation lock. */
export async function createActionCardMessage(
  tx: Prisma.TransactionClient,
  principal: { workspaceId: string; agentId: string },
  target: ActionCardTarget,
  card: {
    kind: ActionCardKind;
    payload: ResolvedActionCardPayload;
    body: string;
    draftHint?: string;
  },
) {
  await lockConversation(tx, target.conversationId);
  const sequence = await allocateSequence(tx, target.conversationId);
  const message = await tx.message.create({
    data: {
      conversationId: target.conversationId,
      workspaceId: principal.workspaceId,
      senderMemberId: target.senderMemberId,
      threadRootId: target.threadRootId,
      body: card.body,
      sequence,
    },
    select: { id: true, sequence: true },
  });
  await tx.actionCard.create({
    data: {
      messageId: message.id,
      conversationId: target.conversationId,
      workspaceId: principal.workspaceId,
      kind: card.kind,
      payload: card.payload as unknown as Prisma.InputJsonValue,
      draftHint: card.draftHint,
      preparedByAgentId: principal.agentId,
    },
  });
  return message;
}

/** A card waits for a person to commit it, so it wakes no Agent; only the browser realtime
 * publish. */
export async function publishActionCardMessage(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  workspaceId: string,
  target: ActionCardTarget,
  message: { id: string; sequence: number },
) {
  try {
    await announceMessage(db, realtime, {
      conversationId: target.conversationId,
      messageId: message.id,
      sequence: message.sequence,
      ...(await messageSignalScope(db, target.conversationId, workspaceId)),
      threadRootId: target.threadRootId,
    });
  } catch {
    // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
  }
}

/** A card's state changed: browsers showing its message refresh it. */
export async function publishActionCardUpdate(
  db: PrismaClient,
  realtime: ConversationRealtime | undefined,
  conversationId: string,
  messageId: string,
) {
  try {
    const message = await db.message.findUnique({
      where: { id: messageId },
      select: { sequence: true, threadRootId: true, workspaceId: true },
    });
    if (message)
      await realtime?.messageAvailable({
        conversationId,
        messageId,
        sequence: message.sequence,
        // A card prepared inside a thread stays a thread reply here: republishing it without
        // its anchor would let the browser count it as a channel message.
        ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
        ...(await messageSignalScope(db, conversationId, message.workspaceId)),
      });
  } catch {
    // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
  }
}
