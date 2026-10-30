import { isValidReactionEmoji } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { readableConversationWhere } from "./channel-read-access.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { writeReaction, type VersionedReactions } from "./reaction-write.server";

/**
 * A signed-in user's own emoji reaction on one conversation message. Conversation-scope
 * authorization (DM ownership) stays with the caller — the DM
 * repository and `PublicChannels` own those checks next to their send paths. This helper also
 * rejects internal destinations and resolves the caller's active membership, then writes the
 * reaction (`writeReaction`, which tells the conversation's open pages through `realtime`) and
 * returns the message's fresh reaction summaries, with their version, for the browser to display.
 */
export async function toggleUserMessageReaction(
  db: PrismaClient,
  realtime: Pick<ConversationRealtime, "reactionChanged"> | undefined,
  input: {
    workspaceId: string;
    conversationId: string;
    userId: string;
    messageId: string;
    emoji: string;
    active: boolean;
  },
): Promise<VersionedReactions> {
  const { workspaceId, conversationId, userId, messageId, emoji, active } = input;
  if (!isValidReactionEmoji(emoji)) throw new AppError("INVALID_INPUT");
  const message = await db.message.findFirst({
    where: {
      id: messageId,
      conversationId,
      workspaceId,
      conversation: readableConversationWhere(workspaceId, { userId }),
    },
    select: { id: true, threadRootId: true },
  });
  if (!message) throw new AppError("NOT_FOUND");
  const member = await db.conversationMember.findFirst({
    where: { conversationId, workspaceId, userId, ...ACTIVE_MEMBER_WHERE },
    select: { id: true },
  });
  if (!member) throw new AppError("ACCESS_DENIED");
  const written = await writeReaction(db, realtime, {
    workspaceId,
    conversationId,
    messageId: message.id,
    threadRootId: message.threadRootId,
    memberId: member.id,
    emoji,
    active,
  });
  // The message was deleted after it was found.
  if (!written) throw new AppError("NOT_FOUND");
  return written;
}
