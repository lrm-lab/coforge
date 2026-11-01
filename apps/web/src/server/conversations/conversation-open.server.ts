import { Prisma } from "#src/generated/prisma/client";
import { conversationUnreadMessageSql } from "#src/server/inbox/activity-inbox-items-sql.server";
import { humanUnreadReplySql } from "./human-unread.server";

/** The first message unread for the viewer, where a pane draws its "New messages" divider. */
export type FirstUnread = { id: string; sequence: number };

/**
 * Where the viewer's unread starts in one of their channels or DMs, or in one thread of it, read
 * when a pane opens (task #378). The pane draws its divider from this read alone, never from a
 * window it may hold from earlier (in memory or the browser's storage), whose cursor is as old as
 * that window.
 *
 * The rule is Activity's, the badge's too: someone else's message past the read cursor or at the
 * mark-as-unread marker (`conversationUnreadMessageSql`); in a thread, someone else's reply past
 * the thread cursor (`humanUnreadReplySql`). A thread the viewer never read has no cursor and no divider: landing on its first
 * reply would bury the conversation they just clicked into. Null for anyone not in the
 * conversation, and for a conversation hidden from the Workspace.
 */
export async function firstUnreadOnOpen(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  open: { workspaceId: string; userId: string; conversationId: string; threadRootId?: string },
): Promise<FirstUnread | null> {
  const { workspaceId, userId, conversationId, threadRootId } = open;
  const unread = threadRootId
    ? Prisma.sql`JOIN "thread_reads" tr
        ON tr."memberId" = cm."id" AND tr."rootMessageId" = ${threadRootId}::uuid
      JOIN "messages" m
        ON m."conversationId" = cm."conversationId" AND m."threadRootId" = ${threadRootId}::uuid
       AND ${humanUnreadReplySql(Prisma.sql`cm."id"`, Prisma.sql`tr."readThroughSequence"`)}`
    : Prisma.sql`JOIN "messages" m ON ${conversationUnreadMessageSql}`;
  const rows = await db.$queryRaw<FirstUnread[]>`
    SELECT m."id" AS "id", m."sequence" AS "sequence"
    FROM "conversation_members" cm
    JOIN "conversations" c
      ON c."id" = cm."conversationId" AND c."workspaceId" = ${workspaceId}::uuid
     AND c."hiddenFromWorkspaceAt" IS NULL
    ${unread}
    WHERE cm."userId" = ${userId}::uuid
      AND cm."conversationId" = ${conversationId}::uuid
      AND cm."leftAt" IS NULL
    ORDER BY m."sequence"
    LIMIT 1`;
  return rows[0] ?? null;
}
