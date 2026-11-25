import { Prisma } from "#src/generated/prisma/client";
import {
  HUMAN_UNREAD_BASE_SQL,
  conversationUnreadMessageSql,
  directThreadsSql,
  followedChannelThreadsSql,
  humanUnreadReplySql,
} from "#src/server/conversations/human-unread.server";
import { viewerDirectConversationSql } from "#src/server/conversations/viewer-direct-conversations.server";

const unreadReplySql = humanUnreadReplySql(
  Prisma.sql`threads."memberId"`,
  Prisma.sql`tr."readThroughSequence"`,
);

export { conversationUnreadMessageSql };

export function threadUnreadReplySql(thread: string) {
  const row = Prisma.raw(thread);
  return Prisma.sql`m."conversationId" = ${row}."conversationId"
    AND m."threadRootId" = ${row}."rootMessageId"
    AND ${humanUnreadReplySql(Prisma.sql`${row}."memberId"`, Prisma.sql`tr."readThroughSequence"`)}`;
}

const conversationUnreadCutoffSql = Prisma.sql`LEAST(cm."readThroughSequence", cm."unreadFromSequence" - 1)`;

const conversationUnreadGateSql = Prisma.sql`latest."sequence" > ${conversationUnreadCutoffSql}`;

export const conversationActiveUnreadGateSql = Prisma.sql`latest."sequence" > GREATEST(
  COALESCE(cm."doneThroughSequence", 0),
  ${conversationUnreadCutoffSql}
)`;

function unreadProbeLateral(unreadMessage: Prisma.Sql, gate: Prisma.Sql = Prisma.sql`TRUE`) {
  return Prisma.sql`LEFT JOIN LATERAL (
  SELECT TRUE AS "found" FROM "messages" m
  WHERE ${unreadMessage}
  ORDER BY m."sequence" LIMIT 1
) unread ON ${gate}`;
}

export const conversationUnreadProbeLateral = unreadProbeLateral(
  conversationUnreadMessageSql,
  conversationUnreadGateSql,
);

export const conversationMentionLateral = Prisma.sql`CROSS JOIN LATERAL (
  SELECT COALESCE(BOOL_OR(${HUMAN_UNREAD_BASE_SQL}), FALSE) AS "unread",
    (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId",
    (ARRAY_AGG(m."id" ORDER BY m."sequence" DESC))[1] AS "lastId",
    MAX(m."sequence") AS "lastSequence",
    MAX(m."createdAt") AS "lastAt"
  FROM "message_mentions" mm
  JOIN "messages" m ON m."id" = mm."messageId" AND m."conversationId" = mm."conversationId"
  WHERE mm."memberId" = cm."id"
    AND m."threadRootId" IS NULL
    AND m."sequence" > COALESCE(cm."doneThroughSequence", 0)
) mention`;

const threadMentionLateral = Prisma.sql`CROSS JOIN LATERAL (
  SELECT COALESCE(BOOL_OR(${unreadReplySql}), FALSE) AS "unread",
    (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
  FROM "messages" m
  WHERE m."conversationId" = threads."conversationId"
    AND m."threadRootId" = threads."rootMessageId"
    AND m."sequence" > COALESCE(tr."doneThroughSequence", 0)
    AND EXISTS (
      SELECT 1 FROM "message_mentions" mm
      WHERE mm."messageId" = m."id" AND mm."memberId" = threads."memberId"
      OFFSET 0
    )
) mention`;

export function conversationItemsSql(workspaceId: string, userId: string) {
  return Prisma.sql`"conversation_members" cm
    JOIN "conversations" c
      ON c."id" = cm."conversationId"
     AND cm."userId" = ${userId}::uuid
     AND cm."workspaceId" = ${workspaceId}::uuid
     AND cm."leftAt" IS NULL
     AND c."workspaceId" = ${workspaceId}::uuid
     AND c."archivedAt" IS NULL
     AND c."hiddenFromWorkspaceAt" IS NULL
    CROSS JOIN LATERAL (
      SELECT m."id", m."sequence", m."createdAt" FROM "messages" m
      WHERE m."conversationId" = cm."conversationId" AND m."threadRootId" IS NULL
      ORDER BY m."sequence" DESC LIMIT 1
    ) latest`;
}

function conversationItemVisibleSql(userId: string) {
  return Prisma.sql`(c."channelName" IS NOT NULL OR ${viewerDirectConversationSql(userId)})`;
}

export const conversationPastDoneSql = Prisma.sql`(latest."sequence" > COALESCE(cm."doneThroughSequence", 0))`;

const mutedChannelItemSql = Prisma.sql`(cm."notificationLevel" = 'muted' AND c."channelName" IS NOT NULL)`;

const conversationListedActivitySql = Prisma.sql`(${conversationPastDoneSql}
  AND (NOT ${mutedChannelItemSql} OR mention."firstId" IS NOT NULL))`;

function conversationLatestSql(mentionColumn: string, latestColumn: string) {
  const mention = Prisma.raw(`mention."${mentionColumn}"`);
  const latest = Prisma.raw(`latest."${latestColumn}"`);
  return Prisma.sql`CASE WHEN ${mutedChannelItemSql} AND mention."firstId" IS NOT NULL
    THEN ${mention} ELSE ${latest} END`;
}

export function conversationItemListedSql(userId: string) {
  return Prisma.sql`${conversationItemVisibleSql(userId)} AND ${conversationPastDoneSql}`;
}

function threadSourcesSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT 'channel' AS "kind", followed.* FROM (${followedChannelThreadsSql(workspaceId, userId)}) followed
    UNION ALL
    SELECT 'direct' AS "kind", direct.* FROM (${directThreadsSql(workspaceId, userId)}) direct`;
}

function markedThreadSourcesSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT CASE WHEN c."channelName" IS NULL THEN 'direct' ELSE 'channel' END AS "kind",
      marked."memberId", marked."conversationId", marked."rootMessageId", TRUE AS "marked"
    FROM "conversation_members" cm
    JOIN "thread_reads" marked ON marked."memberId" = cm."id"
    JOIN "conversations" c ON c."id" = marked."conversationId"
    WHERE cm."userId" = ${userId}::uuid
      AND cm."workspaceId" = ${workspaceId}::uuid
      AND cm."leftAt" IS NULL
      AND marked."markedUnreadVersion" IS NOT NULL
      AND c."archivedAt" IS NULL
      AND c."hiddenFromWorkspaceAt" IS NULL
      AND c."kind" IS DISTINCT FROM 'task_thread'
      AND (c."channelName" IS NOT NULL OR ${viewerDirectConversationSql(userId)})
      AND NOT EXISTS (
        SELECT 1 FROM "tasks" task
        WHERE task."messageId" = marked."rootMessageId" AND task."deletedAt" IS NULL
      )`;
}

export function threadItemsSql(workspaceId: string, userId: string, includeMarks = false) {
  const realSources = threadSourcesSql(workspaceId, userId);
  const sources = includeMarks
    ? Prisma.sql`SELECT "kind", "memberId", "conversationId", "rootMessageId",
        BOOL_OR("marked") AS "marked"
      FROM (
        SELECT real.*, FALSE AS "marked" FROM (${realSources}) real
        UNION ALL
        ${markedThreadSourcesSql(workspaceId, userId)}
      ) candidates
      GROUP BY "kind", "memberId", "conversationId", "rootMessageId"`
    : Prisma.sql`SELECT real.*, FALSE AS "marked" FROM (${realSources}) real`;
  const joinReply = includeMarks ? Prisma.sql`LEFT JOIN` : Prisma.sql`CROSS JOIN`;
  return Prisma.sql`(${sources}) threads
    JOIN "conversations" c ON c."id" = threads."conversationId"
    LEFT JOIN "thread_reads" tr
      ON tr."memberId" = threads."memberId" AND tr."rootMessageId" = threads."rootMessageId"
    ${joinReply} LATERAL (
      SELECT m."id", m."sequence", m."createdAt" FROM "messages" m
      WHERE m."conversationId" = threads."conversationId"
        AND m."threadRootId" = threads."rootMessageId"
      ORDER BY m."sequence" DESC LIMIT 1
    ) latest
    ${
      includeMarks
        ? Prisma.sql`ON TRUE
      LEFT JOIN "messages" root
        ON latest."id" IS NULL AND threads."marked"
        AND root."id" = threads."rootMessageId" AND root."conversationId" = threads."conversationId"`
        : Prisma.empty
    }`;
}

export function threadItemListedSql(userId: string) {
  return Prisma.sql`(latest."sequence" > COALESCE(tr."doneThroughSequence", 0)
    OR threads."marked")
    AND (threads."kind" = 'channel' OR ${viewerDirectConversationSql(userId)})`;
}

export function pendingNoticeSql(workspaceId: string, userId: string) {
  return Prisma.sql`pma."workspaceId" = ${workspaceId}::uuid
    AND pma."targetUserId" = ${userId}::uuid
    AND pma."notifiedAt" IS NOT NULL
    AND pma."dismissedAt" IS NULL`;
}

export function commentSourceReadableSql(userId: string) {
  return Prisma.sql`src."hiddenFromWorkspaceAt" IS NULL AND src."archivedAt" IS NULL
    AND ((src."channelName" IS NOT NULL AND src."visibility" = 'public')
      OR EXISTS (
        SELECT 1 FROM "conversation_members" scm
        WHERE scm."conversationId" = src."id" AND scm."userId" = ${userId}::uuid
          AND scm."leftAt" IS NULL))`;
}

export const ITEM_COLUMNS = Prisma.raw(
  [
    "key",
    "kind",
    "memberId",
    "conversationId",
    "rootMessageId",
    "channelName",
    "visibility",
    "directKey",
    "latestMessageId",
    "latestSequence",
    "latestAt",
    "pastDone",
    "pinOrder",
    "pinnedAt",
    "hasUnread",
    "unreadMention",
    "firstMentionMessageId",
    "taskBoardId",
    "taskNumber",
    "taskTitle",
    "mentionId",
    "noticeThreadRootId",
    "attachmentId",
    "attachmentFileName",
    "attachmentSourceMessageId",
  ]
    .map((column) => `"${column}"`)
    .join(", "),
);

export const noTaskColumns = Prisma.sql`NULL::uuid AS "taskBoardId", NULL::int AS "taskNumber",
  NULL::text AS "taskTitle"`;

export const noNoticeColumns = Prisma.sql`NULL::uuid AS "mentionId",
  NULL::uuid AS "noticeThreadRootId", NULL::uuid AS "attachmentId",
  NULL::text AS "attachmentFileName", NULL::uuid AS "attachmentSourceMessageId"`;

export function conversationItemRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT
      'conversation:' || cm."conversationId" AS "key",
      CASE WHEN c."channelName" IS NOT NULL THEN 'channel' ELSE 'direct' END AS "kind",
      cm."id" AS "memberId",
      cm."conversationId" AS "conversationId",
      NULL::uuid AS "rootMessageId",
      c."channelName" AS "channelName",
      c."visibility" AS "visibility",
      c."directKey" AS "directKey",
      ${conversationLatestSql("lastId", "id")} AS "latestMessageId",
      ${conversationLatestSql("lastSequence", "sequence")} AS "latestSequence",
      ${conversationLatestSql("lastAt", "createdAt")} AS "latestAt",
      ${conversationListedActivitySql} AS "pastDone",
      pin."sortOrder" AS "pinOrder",
      pin."createdAt" AS "pinnedAt",
      CASE WHEN ${mutedChannelItemSql} THEN mention."unread"
        ELSE unread."found" IS NOT NULL END AS "hasUnread",
      mention."unread" AS "unreadMention",
      mention."firstId" AS "firstMentionMessageId",
      ${noTaskColumns},
      ${noNoticeColumns}
    FROM ${conversationItemsSql(workspaceId, userId)}
    LEFT JOIN "conversation_pins" pin
      ON pin."workspaceId" = ${workspaceId}::uuid
     AND pin."memberId" = cm."id"
     AND pin."conversationId" = cm."conversationId"
    ${unreadProbeLateral(
      conversationUnreadMessageSql,
      Prisma.sql`NOT ${mutedChannelItemSql} AND ${conversationUnreadGateSql}`,
    )}
    ${conversationMentionLateral}
    WHERE ${conversationItemVisibleSql(userId)}
      AND ${conversationListedActivitySql}`;
}

export function threadItemRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT
      'thread:' || threads."rootMessageId" AS "key",
      threads."kind" AS "kind",
      threads."memberId" AS "memberId",
      threads."conversationId" AS "conversationId",
      threads."rootMessageId" AS "rootMessageId",
      c."channelName" AS "channelName",
      c."visibility" AS "visibility",
      c."directKey" AS "directKey",
      COALESCE(latest."id", root."id") AS "latestMessageId",
      COALESCE(latest."sequence", root."sequence") AS "latestSequence",
      COALESCE(latest."createdAt", root."createdAt") AS "latestAt",
      TRUE AS "pastDone",
      NULL::int AS "pinOrder",
      NULL::timestamp AS "pinnedAt",
      (threads."marked" OR unread."found" IS NOT NULL) AS "hasUnread",
      mention."unread" AS "unreadMention",
      mention."firstId" AS "firstMentionMessageId",
      ${noTaskColumns},
      ${noNoticeColumns}
    FROM ${threadItemsSql(workspaceId, userId, true)}
    ${unreadProbeLateral(
      threadUnreadReplySql("threads"),
      Prisma.sql`latest."sequence" > COALESCE(tr."readThroughSequence", 0)`,
    )}
    ${threadMentionLateral}
    WHERE ${threadItemListedSql(userId)}`;
}

export function conversationUnreadAttentionRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT
      'conversation:' || cm."conversationId" AS "key",
      CASE WHEN ${mutedChannelItemSql} THEN mention."lastAt" ELSE latest."createdAt" END AS "latestAt",
      CASE WHEN ${mutedChannelItemSql} THEN mention."lastSequence" ELSE latest."sequence" END AS "latestSequence"
    FROM ${conversationItemsSql(workspaceId, userId)}
    ${unreadProbeLateral(
      conversationUnreadMessageSql,
      Prisma.sql`NOT ${mutedChannelItemSql}
        AND ${conversationItemVisibleSql(userId)}
        AND ${conversationActiveUnreadGateSql}`,
    )}
    LEFT JOIN LATERAL (
      SELECT COALESCE(BOOL_OR(${HUMAN_UNREAD_BASE_SQL}), FALSE) AS "unread",
        MAX(m."sequence") AS "lastSequence",
        MAX(m."createdAt") AS "lastAt"
      FROM "message_mentions" mm
      JOIN "messages" m ON m."id" = mm."messageId" AND m."conversationId" = mm."conversationId"
      WHERE mm."memberId" = cm."id"
        AND m."threadRootId" IS NULL
        AND m."sequence" > COALESCE(cm."doneThroughSequence", 0)
    ) mention ON ${mutedChannelItemSql}
      AND ${conversationActiveUnreadGateSql}
    WHERE ${conversationItemVisibleSql(userId)}
      AND ${conversationActiveUnreadGateSql}
      AND (
        CASE WHEN ${mutedChannelItemSql}
          THEN COALESCE(mention."unread", FALSE)
          ELSE unread."found" IS NOT NULL
        END
      )`;
}

export function threadUnreadAttentionRowsSql(workspaceId: string, userId: string) {
  const activeUnread = Prisma.sql`latest."sequence" > GREATEST(
    COALESCE(tr."doneThroughSequence", 0),
    COALESCE(tr."readThroughSequence", 0)
  ) AND (threads."kind" = 'channel' OR ${viewerDirectConversationSql(userId)})`;
  return Prisma.sql`
    SELECT
      'thread:' || threads."rootMessageId" AS "key",
      COALESCE(latest."createdAt", root."createdAt") AS "latestAt",
      COALESCE(latest."sequence", root."sequence") AS "latestSequence"
    FROM ${threadItemsSql(workspaceId, userId, true)}
    ${unreadProbeLateral(threadUnreadReplySql("threads"), activeUnread)}
    WHERE ${threadItemListedSql(userId)}
      AND (threads."marked" OR unread."found" IS NOT NULL)`;
}
