import { Prisma } from "#src/generated/prisma/client";
import type {
  ActivityInboxCursor,
  ActivityInboxFilter,
} from "#src/features/inbox/activity-inbox.schemas";
import {
  ITEM_COLUMNS,
  activityMentionsOnlySql,
  conversationItemRowsSql,
  conversationUnreadAttentionRowsSql,
  conversationUnreadMessageSql,
  threadItemRowsSql,
  threadUnreadAttentionRowsSql,
  threadUnreadReplySql,
} from "./activity-inbox-items-sql.server";
import { taskItemRowsSql, taskUnreadAttentionRowsSql } from "./activity-inbox-task-items.server";
import {
  commentNoticeRowsSql,
  commentNoticeUnreadAttentionRowsSql,
  mentionNoticeRowsSql,
  mentionNoticeUnreadAttentionRowsSql,
} from "./activity-inbox-mentions.server";

export type ActivityPageRow = {
  unreadItemCount: number;
  unreadMentionItemCount: number;
  unreadTaskItemCount: number;
  activeItemCount: number;
  key: string | null;
  isPin: boolean;
  kind: "channel" | "direct";
  memberId: string | null;
  conversationId: string | null;
  rootMessageId: string | null;
  channelName: string | null;
  visibility: string;
  directKey: string | null;
  agentId: string | null;
  latestMessageId: string | null;
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
  markedUnreadVersion: string | null;
};

function viewSql(filter: ActivityInboxFilter) {
  if (filter === "artifacts") return Prisma.sql`FALSE`;
  if (filter === "tasks") return Prisma.sql`items."taskBoardId" IS NOT NULL`;
  if (filter === "unread") return Prisma.sql`items."hasUnread"`;
  if (filter === "mentions") return Prisma.sql`items."firstMentionMessageId" IS NOT NULL`;
  return Prisma.sql`(items."pinOrder" IS NULL OR items."hasUnread")`;
}

function afterSql(cursor: ActivityInboxCursor | undefined) {
  if (!cursor) return Prisma.sql`TRUE`;
  const unread = "hasUnread" in cursor ? Prisma.sql`items."hasUnread",` : Prisma.empty;
  const boundary = "hasUnread" in cursor ? Prisma.sql`${cursor.hasUnread}::boolean,` : Prisma.empty;
  return Prisma.sql`(${unread} items."latestAt", items."latestSequence", items."key" COLLATE "C")
    < (${boundary} ${new Date(cursor.at).toISOString()}::timestamp(3), ${cursor.sequence}::int,
       ${cursor.key}::text COLLATE "C")`;
}

export function activityPageSql(
  workspaceId: string,
  userId: string,
  options: {
    filter: ActivityInboxFilter;
    cursor?: ActivityInboxCursor;
    limit: number;
    selectedKey?: string;
  },
) {
  const unreadFirst = options.filter === "all";
  const mentionsOnly = activityMentionsOnlySql(Prisma.sql`listed."channelName"`);
  return Prisma.sql`
    WITH items AS MATERIALIZED (
      ${activityItemsSql(workspaceId, userId)}
    ), page AS (
      SELECT * FROM items
      WHERE items."pastDone" AND ${viewSql(options.filter)} AND ${afterSql(options.cursor)}
      ORDER BY ${unreadFirst ? Prisma.sql`items."hasUnread" DESC,` : Prisma.empty}
        items."latestAt" DESC, items."latestSequence" DESC, items."key" COLLATE "C" DESC
      LIMIT ${options.limit + 1}
    ), listed AS (
      SELECT FALSE AS "isPin", page.* FROM page
      ${
        options.selectedKey
          ? Prisma.sql`UNION ALL
          SELECT FALSE AS "isPin", items.* FROM items
          WHERE items."key" = ${options.selectedKey} AND items."pastDone" AND ${viewSql(options.filter)}
            AND NOT EXISTS (SELECT 1 FROM page WHERE page."key" = items."key")`
          : Prisma.empty
      }
      ${pinsSql(options.filter, options.cursor)}
    ), counts AS (
      SELECT
        (COUNT(*) FILTER (WHERE items."pastDone" AND items."hasUnread"))::int
          AS "unreadItemCount",
        (COUNT(*) FILTER (WHERE items."pastDone" AND items."unreadMention"))::int
          AS "unreadMentionItemCount",
        (COUNT(*) FILTER (WHERE items."pastDone" AND items."hasUnread" AND items."taskBoardId" IS NOT NULL))::int
          AS "unreadTaskItemCount",
        (COUNT(*) FILTER (WHERE items."pastDone"))::int
          AS "activeItemCount"
      FROM items
    )
    SELECT counts.*, listed.*, tr."markedUnreadVersion",
      peer."agentId" AS "agentId",
      CASE
        WHEN listed."mentionId" IS NOT NULL THEN listed."hasUnread"::int
        WHEN listed."rootMessageId" IS NOT NULL THEN GREATEST(COALESCE(replies."count", 0), listed."hasUnread"::int)
        ELSE COALESCE(unread."count", 0)
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
    LEFT JOIN LATERAL (
      SELECT am."agentId" FROM "conversation_members" am
      LEFT JOIN "agents" a ON a."id" = am."agentId"
      WHERE am."conversationId" = listed."conversationId"
        AND am."agentId" IS NOT NULL
        AND (listed."attachmentId" IS NOT NULL OR a."deletedAt" IS NULL)
      LIMIT 1
    ) peer ON listed."kind" = 'direct'
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS "count", (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
      FROM "messages" m
      WHERE ${conversationUnreadMessageSql}
        AND (NOT ${mentionsOnly}
          OR listed."taskBoardId" IS NOT NULL OR EXISTS (
            SELECT 1 FROM "message_mentions" mm
            WHERE mm."messageId" = m."id" AND mm."memberId" = cm."id"
          ))
    ) unread ON listed."mentionId" IS NULL
      AND listed."rootMessageId" IS NULL
      AND (listed."hasUnread" OR cm."notificationLevel" = 'muted')
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS "count", (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
      FROM "messages" m
      WHERE ${threadUnreadReplySql("listed")}
    ) replies ON listed."mentionId" IS NULL
      AND listed."rootMessageId" IS NOT NULL
      AND listed."hasUnread"
    ORDER BY listed."isPin" DESC,
      CASE WHEN listed."isPin" THEN listed."pinOrder" END,
      CASE WHEN listed."isPin" THEN listed."pinnedAt" END,
      ${unreadFirst ? Prisma.sql`listed."hasUnread" DESC,` : Prisma.empty}
      listed."latestAt" DESC, listed."latestSequence" DESC, listed."key" COLLATE "C" DESC`;
}

export function activityItemsSql(workspaceId: string, userId: string) {
  return Prisma.join(
    [
      conversationItemRowsSql(workspaceId, userId),
      threadItemRowsSql(workspaceId, userId),
      taskItemRowsSql(workspaceId, userId),
      mentionNoticeRowsSql(workspaceId, userId),
      commentNoticeRowsSql(workspaceId, userId),
    ].map((branch) => Prisma.sql`SELECT ${ITEM_COLUMNS} FROM (${branch}) branch`),
    " UNION ALL ",
  );
}

function pinsSql(filter: ActivityInboxFilter, cursor: ActivityInboxCursor | undefined) {
  return filter === "all" && !cursor
    ? Prisma.sql`UNION ALL
      SELECT TRUE AS "isPin", items.* FROM items
      WHERE items."pastDone" AND items."pinOrder" IS NOT NULL AND NOT items."hasUnread"`
    : Prisma.empty;
}

export const NAV_UNREAD_KEY_LIMIT = 100;

export function activityNavAttentionSql(workspaceId: string, userId: string) {
  const branches = Prisma.join(
    [
      conversationUnreadAttentionRowsSql(workspaceId, userId),
      threadUnreadAttentionRowsSql(workspaceId, userId),
      taskUnreadAttentionRowsSql(workspaceId, userId),
      mentionNoticeUnreadAttentionRowsSql(workspaceId, userId),
      commentNoticeUnreadAttentionRowsSql(workspaceId, userId),
    ].map(
      (branch) => Prisma.sql`SELECT "key", "latestAt", "latestSequence" FROM (${branch}) branch`,
    ),
    " UNION ALL ",
  );
  return Prisma.sql`
    WITH items AS MATERIALIZED (
      ${branches}
    )
    SELECT items."key", items."latestAt", items."latestSequence"
    FROM items
    ORDER BY items."latestAt" DESC, items."latestSequence" DESC, items."key" COLLATE "C" DESC
    LIMIT ${NAV_UNREAD_KEY_LIMIT}`;
}
