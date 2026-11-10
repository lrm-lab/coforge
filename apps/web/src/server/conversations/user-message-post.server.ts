import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { MessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { sendChannel } from "./channel-send.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { DirectConversations } from "./direct-conversations.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";

export type UserMessagePostPorts = {
  db: PrismaClient;
  idempotency: MessageRequestIdempotency;
  publisher: CentrifugoServerApi;
  realtime?: ConversationRealtime;
  notifications?: MessageNotifier;
  /** Work a send into a direct conversation needs first (an assistant's Computer). */
  prepareDirect?: (workspaceId: string, userId: string, conversationId: string) => Promise<void>;
};

/**
 * Posts a person's plain message into a channel or a direct conversation named by id, under the
 * checks their own composer's send has there: a channel they are an active member of and that is
 * not archived, or a DM they may send in. A conversation hidden from the Workspace, or one that
 * is neither, answers as missing.
 */
export async function postUserMessage(
  ports: UserMessagePostPorts,
  input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    idempotencyKey: string;
    body: string;
  },
): Promise<{ id: string; sequence: number }> {
  const { db } = ports;
  const { workspaceId, userId, conversationId, idempotencyKey, body } = input;
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId, kind: null, ...VISIBLE_CONVERSATION_WHERE },
    select: { channelName: true, directKey: true },
  });
  if (!conversation) throw new AppError("NOT_FOUND");
  if (conversation.channelName !== null)
    return sendChannel(
      {
        db,
        idempotency: ports.idempotency,
        notifications: ports.notifications,
        realtime: ports.realtime,
        publisher: ports.publisher,
      },
      { workspaceId, userId, channelId: conversationId, idempotencyKey, body },
    );
  if (conversation.directKey === null) throw new AppError("NOT_FOUND");
  const direct = new DirectConversations(db);
  // Checked before the preparation, as the composer's send does: nothing is set up for a DM the
  // person may not post in.
  await direct.authorize(workspaceId, userId, conversationId, { canSend: true });
  await ports.prepareDirect?.(workspaceId, userId, conversationId);
  return direct.send(
    workspaceId,
    userId,
    conversationId,
    { idempotencyKey, body },
    { idempotency: ports.idempotency, centrifugo: ports.publisher, realtime: ports.realtime },
  );
}
