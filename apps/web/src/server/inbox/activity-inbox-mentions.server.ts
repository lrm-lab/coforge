import { Prisma } from "#src/generated/prisma/client";
import { readableChannelSql } from "#src/server/conversations/channel-read-access.server";
import {
  commentSourceReadableSql,
  noTaskColumns,
  pendingNoticeSql,
} from "./activity-inbox-items-sql.server";

const noticeColumns = Prisma.sql`
      'mention:' || pma."id" AS "key",
      NULL::uuid AS "memberId",
      NULL::uuid AS "rootMessageId",
      pma."messageId" AS "latestMessageId",
      m."sequence" AS "latestSequence",
      pma."notifiedAt" AS "latestAt",
      TRUE AS "pastDone",
      NULL::int AS "pinOrder",
      NULL::timestamp AS "pinnedAt",
      pma."targetReadAt" IS NULL AS "hasUnread",
      pma."targetReadAt" IS NULL AS "unreadMention",
      pma."messageId" AS "firstMentionMessageId",
      ${noTaskColumns},
      pma."id" AS "mentionId",
      m."threadRootId" AS "noticeThreadRootId"`;

export function mentionNoticeRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT ${noticeColumns},
      'channel' AS "kind",
      pma."conversationId" AS "conversationId",
      pc."channelName" AS "channelName",
      pc."visibility" AS "visibility",
      NULL::text AS "directKey",
      NULL::uuid AS "attachmentId",
      NULL::text AS "attachmentFileName",
      NULL::uuid AS "attachmentSourceMessageId"
    FROM "pending_mention_actions" pma
    JOIN "messages" m ON m."id" = pma."messageId" AND m."conversationId" = pma."conversationId"
    JOIN "conversations" pc
      ON pc."id" = m."conversationId"
     AND pc."archivedAt" IS NULL
     AND ${readableChannelSql("pc", workspaceId, { userId })}
    WHERE ${pendingNoticeSql(workspaceId, userId)}
      AND pma."reason" IS NULL`;
}

export function commentNoticeRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT ${noticeColumns},
      CASE WHEN src."channelName" IS NOT NULL THEN 'channel' ELSE 'direct' END AS "kind",
      src."id" AS "conversationId",
      src."channelName" AS "channelName",
      src."visibility" AS "visibility",
      src."directKey" AS "directKey",
      att."id" AS "attachmentId",
      att."fileName" AS "attachmentFileName",
      att."messageId" AS "attachmentSourceMessageId"
    FROM "pending_mention_actions" pma
    JOIN "messages" m ON m."id" = pma."messageId" AND m."conversationId" = pma."conversationId"
    JOIN "attachment_comments" ac ON ac."messageId" = pma."messageId"
    JOIN "attachments" att ON att."id" = ac."attachmentId" AND att."workspaceId" = ${workspaceId}::uuid
    JOIN "conversations" src
      ON src."id" = att."conversationId"
     AND ${commentSourceReadableSql(userId)}
    WHERE ${pendingNoticeSql(workspaceId, userId)}`;
}

export function mentionNoticeUnreadAttentionRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT
      'mention:' || pma."id" AS "key",
      pma."notifiedAt" AS "latestAt",
      m."sequence" AS "latestSequence"
    FROM "pending_mention_actions" pma
    JOIN "conversations" pc
      ON pc."id" = pma."conversationId"
     AND pc."archivedAt" IS NULL
     AND ${readableChannelSql("pc", workspaceId, { userId })}
    CROSS JOIN LATERAL (
      SELECT m."sequence" FROM "messages" m
      WHERE m."id" = pma."messageId" AND m."conversationId" = pma."conversationId"
    ) m
    WHERE ${pendingNoticeSql(workspaceId, userId)}
      AND pma."reason" IS NULL
      AND pma."targetReadAt" IS NULL`;
}

export function commentNoticeUnreadAttentionRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT
      'mention:' || pma."id" AS "key",
      pma."notifiedAt" AS "latestAt",
      m."sequence" AS "latestSequence"
    FROM "pending_mention_actions" pma
    JOIN "attachment_comments" ac ON ac."messageId" = pma."messageId"
    JOIN "attachments" att ON att."id" = ac."attachmentId" AND att."workspaceId" = ${workspaceId}::uuid
    JOIN "conversations" src
      ON src."id" = att."conversationId"
     AND ${commentSourceReadableSql(userId)}
    CROSS JOIN LATERAL (
      SELECT m."sequence" FROM "messages" m
      WHERE m."id" = pma."messageId" AND m."conversationId" = pma."conversationId"
    ) m
    WHERE ${pendingNoticeSql(workspaceId, userId)}
      AND pma."targetReadAt" IS NULL`;
}
