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
  const [channel, member] = await Promise.all([
    memberChannel(db, workspaceId, userId, channelId),
    db.conversationMember.findFirst({
      where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarObjectKey: true,
            description: true,
          },
        },
      },
    }),
  ]);
  if (channel.archivedAt) throw new AppError("CONFLICT");
  if (!member) throw new AppError("ACCESS_DENIED");
  return { channel, member };
}
