import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
  VISIBLE_CONVERSATION_WHERE,
  TARGETABLE_CONVERSATION_WHERE,
} from "./active-member.server";

/** Generic subscriptions require a channel/DM destination as well as the current viewer grant. */
export async function authorizeConversationRealtime(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; conversationId: string },
) {
  const conversation = await db.conversation.findFirst({
    where: {
      id: input.conversationId,
      workspaceId: input.workspaceId,
      AND: [TARGETABLE_CONVERSATION_WHERE],
      OR: [
        {
          ...DIRECT_CONVERSATION_WHERE,
          members: { some: { userId: input.userId, ...ACTIVE_MEMBER_WHERE } },
        },
        {
          channelName: { not: null },
          ...VISIBLE_CONVERSATION_WHERE,
          workspace: { members: { some: { userId: input.userId } } },
        },
      ],
    },
    select: { id: true },
  });
  if (!conversation) throw new AppError("ACCESS_DENIED");
  return conversation.id;
}
