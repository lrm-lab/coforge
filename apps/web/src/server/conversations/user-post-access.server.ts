import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { requireUserMayPostInChannel } from "./channel-post-access.server";
import { DirectConversations } from "./direct-conversations.server";

export async function assertUserMayPost(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  conversationId: string,
): Promise<void> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId, kind: null, ...VISIBLE_CONVERSATION_WHERE },
    select: { channelName: true, directKey: true },
  });
  if (!conversation) throw new AppError("NOT_FOUND");
  if (conversation.channelName !== null) {
    await requireUserMayPostInChannel(db, workspaceId, userId, conversationId);
    return;
  }
  if (conversation.directKey === null) throw new AppError("NOT_FOUND");
  await new DirectConversations(db).authorize(workspaceId, userId, conversationId, {
    canSend: true,
  });
}
