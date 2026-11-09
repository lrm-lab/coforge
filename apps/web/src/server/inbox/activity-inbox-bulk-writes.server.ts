import type { PrismaClient } from "#src/generated/prisma/client";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import type { ActivityDoneUndo } from "#src/features/inbox/activity-inbox.schemas";
import { announceActivityAttention, announceReadMoved } from "./activity-attention.server";
import type { ActivityInboxRealtime } from "./activity-inbox-writes.server";
import {
  allConversationsTargetSql,
  allThreadsTargetSql,
  conversationsDoneSql,
  restoreConversationsDoneSql,
  restoreThreadsDoneSql,
  threadsDoneSql,
  type ConversationDoneRow,
  type ThreadDoneRow,
} from "./activity-inbox-bulk-sql.server";

/**
 * The Activity inbox's bulk writes: Mark all done and its Undo. They are set-based (a statement per
 * kind of item, not a round trip per row) and announce once, at the end. Every statement reaches
 * only the caller's own member rows.
 */

/** How many changed rows a Mark all done may hand back for Undo; a bigger write is final. */
const UNDO_ROW_LIMIT = 5_000;

export type ActivityBulkDone = {
  /** How many items the write took off the list. */
  count: number;
  /** What Undo needs, or null when the write changed nothing or was too large to take back. */
  undo: ActivityDoneUndo | null;
};

/** The undo payload of what a Done changed: only rows whose boundary really moved. */
function undoOf(
  conversations: ConversationDoneRow[],
  threads: ThreadDoneRow[],
  mentions: { ids: string[]; at: Date },
): ActivityDoneUndo | null {
  const moved = <Row extends { previous: number | null; through: number }>(row: Row) =>
    row.previous === null || row.previous < row.through;
  const members = conversations
    .filter(moved)
    .map(({ memberId, previous, through }) => ({ memberId, previous, through }));
  const threadRows = threads
    .filter(moved)
    .map(({ memberId, rootMessageId, previous, through }) => ({
      memberId,
      rootMessageId,
      previous,
      through,
    }));
  const rows = members.length + threadRows.length + mentions.ids.length;
  if (rows === 0 || rows > UNDO_ROW_LIMIT) return null;
  return {
    members,
    threads: threadRows,
    mentions: { ids: mentions.ids, at: mentions.at.getTime() },
  };
}

/** Dismisses the caller's mention actions notified at or before `before`, returning the ones it
 * dismissed. */
function dismissMentions(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  before: Date,
  at: Date,
) {
  return db.$queryRaw<{ id: string }[]>`
    UPDATE "pending_mention_actions" SET "dismissedAt" = ${at}
    WHERE "workspaceId" = ${workspaceId}::uuid AND "targetUserId" = ${userId}::uuid
      AND "notifiedAt" IS NOT NULL AND "notifiedAt" <= ${before}
      AND "dismissedAt" IS NULL
    RETURNING "id"`;
}

async function announceDone(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  conversations: ConversationDoneRow[],
) {
  // A conversation's Done reads it too, so its badge moves when its read cursor did (a thread's
  // Done never touches the badge, and a task's own conversation has none).
  await announceReadMoved(
    db,
    realtime,
    workspaceId,
    userId,
    conversations.filter((row) => row.readMoved && !row.task),
  );
}

/**
 * Marks everything the inbox lists Done through the newest message posted at or before `before`
 * (the list's `loadedAt`), in one transaction: an item that heard something newer stays listed.
 * Its scope is the listing's own (`activity-inbox-items-sql.server.ts`), plus the notified
 * mention actions Mark all read covers.
 */
export async function markActivityAllDone(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  options: { before: Date },
): Promise<ActivityBulkDone> {
  await requireWorkspaceMember(db, workspaceId, userId);
  const { before } = options;
  const at = new Date();
  const [conversations, threads, mentions] = await db.$transaction([
    db.$queryRaw<ConversationDoneRow[]>(
      conversationsDoneSql(allConversationsTargetSql(workspaceId, userId, before)),
    ),
    db.$queryRaw<ThreadDoneRow[]>(
      threadsDoneSql(workspaceId, allThreadsTargetSql(workspaceId, userId, before)),
    ),
    dismissMentions(db, workspaceId, userId, before, at),
  ]);
  await announceDone(db, realtime, workspaceId, userId, conversations);
  const ids = mentions.map((row) => row.id);
  return {
    count: conversations.length + threads.length + ids.length,
    undo: undoOf(conversations, threads, { ids, at }),
  };
}

/**
 * Takes back a Mark all done: each member row and thread goes back to the Done boundary it held, only
 * if it still holds exactly what the write left, so a newer Done (or a Done of the same item
 * since) is never overwritten; each dismissed mention is shown again only if its dismissal is that
 * write's. Only the caller's own rows are reachable, whatever the payload names. Read state is not
 * restored.
 */
export async function undoActivityDone(
  db: PrismaClient,
  realtime: ActivityInboxRealtime | undefined,
  workspaceId: string,
  userId: string,
  undo: ActivityDoneUndo,
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  await db.$transaction([
    db.$executeRaw(restoreConversationsDoneSql(workspaceId, userId, undo.members)),
    db.$executeRaw(restoreThreadsDoneSql(workspaceId, userId, undo.threads)),
    db.pendingMentionAction.updateMany({
      where: {
        id: { in: undo.mentions.ids },
        workspaceId,
        targetUserId: userId,
        dismissedAt: new Date(undo.mentions.at),
      },
      data: { dismissedAt: null },
    }),
  ]);
  await announceActivityAttention(db, realtime, workspaceId, userId);
}
