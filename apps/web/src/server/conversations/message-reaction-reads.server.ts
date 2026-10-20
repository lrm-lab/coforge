import type { PrismaClient } from "#src/generated/prisma/client";
import { ConversationHistory } from "./conversation-history.server";
import { MESSAGE_REACTIONS_SELECT, reactionSummaries } from "./message-reactions.server";
import type { VersionedReactions } from "./reaction-write.server";

/**
 * The current reactions of some of one conversation's messages, for a page that shows them and
 * may have missed a change: each message id the conversation holds maps to its summaries (`null`
 * once no reaction is left) and their `reactionVersion`; an id from elsewhere is left out. One
 * REPEATABLE READ snapshot reads both, so a version labels exactly the summary beside it. The
 * viewer may read the conversation by the same rule as its history
 * (`ConversationHistory.authorize`), which already shows them these reactions.
 */
export async function readMessageReactions(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; conversationId: string; messageIds: string[] },
): Promise<Record<string, VersionedReactions>> {
  const { workspaceId, userId, conversationId, messageIds } = input;
  await new ConversationHistory(db).authorize(workspaceId, userId, conversationId);
  if (!messageIds.length) return {};
  const [messages] = await db.$transaction(
    [
      db.message.findMany({
        where: { id: { in: messageIds }, conversationId, workspaceId },
        select: { id: true, reactionVersion: true, reactions: MESSAGE_REACTIONS_SELECT },
      }),
    ],
    { isolationLevel: "RepeatableRead" },
  );
  return Object.fromEntries(
    messages.map((message) => [
      message.id,
      { reactions: reactionSummaries(message.reactions) ?? null, version: message.reactionVersion },
    ]),
  );
}
