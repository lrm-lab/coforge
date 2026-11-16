import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { memberChannel } from "./channel-access.server";
import { DirectConversations } from "./direct-conversations.server";

export async function requireUserMayPostInChannel(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  channelId: string,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  if (channel.archivedAt) throw new AppError("CONFLICT");
  const member = await db.conversationMember.findFirst({
    where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
  });
  if (!member) throw new AppError("ACCESS_DENIED");
  return { channel, member };
}

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
