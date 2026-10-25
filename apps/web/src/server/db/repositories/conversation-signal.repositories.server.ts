import type { PrismaClient } from "#src/generated/prisma/client";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";

/** Read only real DM participants when choosing message and Task signal destinations. */
export function readConversationSignalParticipants(db: PrismaClient, conversationId: string) {
  return db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      channelName: true,
      directKey: true,
      // Only a direct message's members name where it goes; a channel's roster (all of
      // `#general`) is never read. A person who left the Workspace hears of nothing new; a
      // deleted Agent's row still says whose conversation it is.
      members: {
        where: {
          conversation: DIRECT_CONVERSATION_WHERE,
          OR: [{ agentId: { not: null } }, ACTIVE_MEMBER_WHERE],
        },
        select: { userId: true, agentId: true },
      },
    },
  });
}
