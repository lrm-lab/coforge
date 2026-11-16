import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { memberChannel } from "./channel-access.server";

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
