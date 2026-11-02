import { Prisma } from "#src/generated/prisma/client";
import type {
  ActivityInboxCursor,
  ActivityInboxFilter,
} from "#src/features/inbox/activity-inbox.schemas";
import {
  ITEM_COLUMNS,
  conversationItemRowsSql,
  conversationUnreadMessageSql,
  threadItemRowsSql,
  threadUnreadReplySql,
} from "./activity-inbox-items-sql.server";
import { taskItemRowsSql } from "./activity-inbox-task-items.server";
import { commentNoticeRowsSql, mentionNoticeRowsSql } from "./activity-inbox-mentions.server";

/**
 * One page of the Activity inbox as one statement. Every item is read once, cheaply: its newest
 * message, its Done and pin, and probes for whether anything in it is unread or mentions the
 * viewer. The database filters, orders and cuts the page from those, counts the tabs over all of
 * them, and only then counts the unread messages of the items on the page.
 *
 * Items are ordered newest activity first by `(latestAt, latestSequence, key)`, and a page starts
 * after a cursor in that order rather than at an offset: activity that moves an item between two
 * page reads neither repeats nor skips one.
 */

/** A page row: an item with its unread count, or none when the page is empty, and the counts. */
export type ActivityPageRow = {
  unreadItemCount: number;
  unreadMentionItemCount: number;
  activeItemCount: number;
  /** Null on the one row of an empty page, which carries only the counts. */
  key: string | null;
  isPin: boolean;
  kind: "channel" | "direct";
  memberId: string | null;
  conversationId: string;
  rootMessageId: string | null;
  channelName: string | null;
  visibility: string;
  directKey: string | null;
  agentId: string | null;
  latestMessageId: string;
  latestSequence: number;
  latestAt: Date;
  pastDone: boolean;
  hasUnread: boolean;
  pinOrder: number | null;
  pinnedAt: Date | null;
  unreadMention: boolean;
  firstMentionMessageId: string | null;
  taskBoardId: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
  mentionId: string | null;
  noticeThreadRootId: string | null;
  attachmentId: string | null;
  attachmentFileName: string | null;
  attachmentSourceMessageId: string | null;
  unreadCount: number;
  firstUnreadMessageId: string | null;
};

/** Which listed items a view shows. The All view lists pinned conversations apart. */
function viewSql(filter: ActivityInboxFilter) {
  if (filter === "unread") return Prisma.sql`items."hasUnread"`;
  if (filter === "mentions") return Prisma.sql`items."firstMentionMessageId" IS NOT NULL`;
  return Prisma.sql`items."pinOrder" IS NULL`;
}

/** The items after `cursor` in list order; every item when there is none. */
function afterSql(cursor: ActivityInboxCursor | undefined) {
  if (!cursor) return Prisma.sql`TRUE`;
  return Prisma.sql`(items."latestAt", items."latestSequence", items."key" COLLATE "C")
    < (${new Date(cursor.at).toISOString()}::timestamp(3), ${cursor.sequence}::int,
       ${cursor.key}::text COLLATE "C")`;
}

export function activityPageSql(
  workspaceId: string,
  userId: string,
  options: { filter: ActivityInboxFilter; cursor?: ActivityInboxCursor; limit: number },
) {
  const branches = [
    conversationItemRowsSql(workspaceId, userId),
    threadItemRowsSql(workspaceId, userId),
    taskItemRowsSql(workspaceId, userId),
    mentionNoticeRowsSql(workspaceId, userId),
    commentNoticeRowsSql(workspaceId, userId),
  ].map((branch) => Prisma.sql`SELECT ${ITEM_COLUMNS} FROM (${branch}) branch`);
  // The All view's first page lists the viewer's pins, whatever their Done.
  const pins =
    options.filter === "all" && !options.cursor
      ? Prisma.sql`UNION ALL
      SELECT TRUE AS "isPin", items.* FROM items WHERE items."pinOrder" IS NOT NULL`
      : Prisma.empty;
  return Prisma.sql`
    WITH items AS MATERIALIZED (
      ${Prisma.join(branches, " UNION ALL ")}
    ), page AS (
      SELECT * FROM items
      WHERE items."pastDone" AND ${viewSql(options.filter)} AND ${afterSql(options.cursor)}
      ORDER BY items."latestAt" DESC, items."latestSequence" DESC, items."key" COLLATE "C" DESC
      -- One past the page says whether there is a next one.
      LIMIT ${options.limit + 1}
    ), listed AS (
      SELECT FALSE AS "isPin", page.* FROM page
      ${pins}
    ), counts AS (
      SELECT
        (COUNT(*) FILTER (WHERE items."pastDone" AND items."hasUnread"))::int
          AS "unreadItemCount",
        (COUNT(*) FILTER (WHERE items."pastDone" AND items."unreadMention"))::int
          AS "unreadMentionItemCount",
        (COUNT(*) FILTER (WHERE items."pastDone" OR items."pinOrder" IS NOT NULL))::int
          AS "activeItemCount"
      FROM items
    )
    SELECT counts.*, listed.*,
      CASE
        WHEN listed."mentionId" IS NOT NULL THEN listed."hasUnread"::int
        WHEN listed."rootMessageId" IS NOT NULL THEN replies."count"
        ELSE unread."count"
      END AS "unreadCount",
      CASE
        WHEN listed."mentionId" IS NOT NULL
          THEN CASE WHEN listed."hasUnread" THEN listed."latestMessageId" END
        WHEN listed."rootMessageId" IS NOT NULL THEN replies."firstId"
        ELSE unread."firstId"
      END AS "firstUnreadMessageId"
    FROM counts
    LEFT JOIN listed ON TRUE
    LEFT JOIN "conversation_members" cm ON cm."id" = listed."memberId"
    LEFT JOIN "thread_reads" tr
      ON tr."memberId" = listed."memberId" AND tr."rootMessageId" = listed."rootMessageId"
    -- A conversation or task item's unread top-level messages.
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS "count", (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
      FROM "messages" m
      WHERE listed."rootMessageId" IS NULL AND ${conversationUnreadMessageSql}
    ) unread ON TRUE
    -- A thread item's unread replies.
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS "count", (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
      FROM "messages" m
      WHERE ${threadUnreadReplySql("listed")}
    ) replies ON TRUE
    -- Pins first, in pin order; then the page in list order, where a pinned conversation an Unread or
    -- Mentions page lists keeps its place in time.
    ORDER BY listed."isPin" DESC,
      CASE WHEN listed."isPin" THEN listed."pinOrder" END,
      CASE WHEN listed."isPin" THEN listed."pinnedAt" END,
      listed."latestAt" DESC, listed."latestSequence" DESC, listed."key" COLLATE "C" DESC`;
}
