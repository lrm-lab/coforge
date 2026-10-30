import type { PrismaClient } from "#src/generated/prisma/client";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";

/** Read only real DM participants, or a private channel's, when choosing signal destinations. */
export function readConversationSignalParticipants(db: PrismaClient, conversationId: string) {
  return db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      channelName: true,
      directKey: true,
      visibility: true,
      // Only a direct message's or a private channel's members name where it goes; a public
      // channel's roster (all of `#general`) is never read. A person who left hears of nothing
      // new; a deleted Agent's row still says whose direct message it is.
      members: {
        where: {
          conversation: {
            OR: [DIRECT_CONVERSATION_WHERE, { visibility: CHANNEL_VISIBILITY.PRIVATE }],
          },
          OR: [{ agentId: { not: null } }, ACTIVE_MEMBER_WHERE],
        },
        select: { userId: true, agentId: true },
      },
    },
  });
}
