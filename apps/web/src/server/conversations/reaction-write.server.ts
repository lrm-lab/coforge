import type { PrismaClient } from "#src/generated/prisma/client";
import { announceReactionChanged, type ConversationRealtime } from "./conversation-realtime.server";
import {
  MESSAGE_REACTIONS_SELECT,
  reactionSummaries,
  type MessageReactionSummary,
} from "./message-reactions.server";

/** What `writeReaction` announces through. */
export type ReactionPort = Pick<ConversationRealtime, "reactionChanged">;

/** A message's reactions as of one `reactionVersion` (see `writeReaction`). */
export type VersionedReactions = { reactions: MessageReactionSummary[] | null; version: number };

/**
 * The one write of a member's reaction (a person's or an Agent's, already authorized). One
 * transaction raises the message's `reactionVersion`, locking its row until commit so one message's
 * writes take versions in commit order, writes the reaction and reads the summary that version
 * labels; after commit `message.reaction.v1` carries both to open pages (`reaction-sync.ts`).
 * Resolves to undefined, writing and announcing nothing, when the message is gone.
 */
export async function writeReaction(
  db: PrismaClient,
  realtime: ReactionPort | undefined,
  input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    /** The message's thread root, for a reply. */
    threadRootId: string | null;
    memberId: string;
    emoji: string;
    active: boolean;
  },
): Promise<VersionedReactions | undefined> {
  const { workspaceId, conversationId, messageId, threadRootId, memberId, emoji, active } = input;
  const written = await db.$transaction(async (tx) => {
    const [bumped] = await tx.message.updateManyAndReturn({
      where: { id: messageId, conversationId, workspaceId },
      data: { reactionVersion: { increment: 1 } },
      select: { reactionVersion: true },
    });
    if (!bumped) return undefined;
    if (active)
      await tx.messageReaction.upsert({
        where: { messageId_memberId_emoji: { messageId, memberId, emoji } },
        create: { messageId, conversationId, workspaceId, memberId, emoji },
        update: {},
      });
    else await tx.messageReaction.deleteMany({ where: { messageId, memberId, emoji } });
    const rows = await tx.messageReaction.findMany({
      where: { messageId },
      ...MESSAGE_REACTIONS_SELECT,
    });
    return { reactions: reactionSummaries(rows) ?? null, version: bumped.reactionVersion };
  });
  if (written)
    await announceReactionChanged(realtime, workspaceId, {
      conversationId,
      messageId,
      ...(threadRootId ? { threadRootId } : {}),
      ...written,
    });
  return written;
}
