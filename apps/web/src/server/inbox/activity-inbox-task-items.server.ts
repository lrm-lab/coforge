import { Prisma } from "#src/generated/prisma/client";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import {
  conversationActiveUnreadGateSql,
  conversationMentionLateral,
  conversationPastDoneSql,
  conversationUnreadMessageSql,
  conversationUnreadProbeLateral,
  noNoticeColumns,
} from "./activity-inbox-items-sql.server";

export function taskItemsSql(workspaceId: string, userId: string) {
  return Prisma.sql`"conversation_members" cm
    JOIN "conversations" c
      ON c."id" = cm."conversationId"
     AND cm."userId" = ${userId}::uuid
     AND cm."workspaceId" = ${workspaceId}::uuid
     AND cm."leftAt" IS NULL
     AND c."kind" = 'task_thread'
    JOIN "tasks" t ON t."discussionConversationId" = c."id" AND t."deletedAt" IS NULL
    JOIN "conversations" b
      ON b."id" = t."conversationId"
     AND b."channelName" IS NOT NULL
     AND b."archivedAt" IS NULL
     AND b."hiddenFromWorkspaceAt" IS NULL
    LEFT JOIN "conversation_members" bm
      ON bm."conversationId" = b."id" AND bm."userId" = ${userId}::uuid AND bm."leftAt" IS NULL
    LEFT JOIN "task_follows" tf ON tf."taskId" = t."id" AND tf."memberId" = bm."id"
    CROSS JOIN LATERAL (
      SELECT m."id", m."sequence", m."createdAt" FROM "messages" m
      WHERE m."conversationId" = cm."conversationId" AND m."threadRootId" IS NULL
      ORDER BY m."sequence" DESC LIMIT 1
    ) latest`;
}

const taskBoardReadableSql = Prisma.sql`(b."visibility" = ${CHANNEL_VISIBILITY.PUBLIC} OR bm."id" IS NOT NULL)`;

export const taskItemListedSql = (mentionFirstId: Prisma.Sql) => Prisma.sql`${taskBoardReadableSql}
  AND ${conversationPastDoneSql}
  AND (tf."taskId" IS NOT NULL OR ${mentionFirstId} IS NOT NULL)`;

export function taskItemRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT
      'conversation:' || cm."conversationId" AS "key",
      'channel' AS "kind",
      cm."id" AS "memberId",
      cm."conversationId" AS "conversationId",
      NULL::uuid AS "rootMessageId",
      b."channelName" AS "channelName",
      b."visibility" AS "visibility",
      NULL::text AS "directKey",
      latest."id" AS "latestMessageId",
      latest."sequence" AS "latestSequence",
      latest."createdAt" AS "latestAt",
      TRUE AS "pastDone",
      NULL::int AS "pinOrder",
      NULL::timestamp AS "pinnedAt",
      unread."found" IS NOT NULL AS "hasUnread",
      mention."unread" AS "unreadMention",
      mention."firstId" AS "firstMentionMessageId",
      b."id" AS "taskBoardId",
      t."number" AS "taskNumber",
      t."title" AS "taskTitle",
      ${noNoticeColumns}
    FROM ${taskItemsSql(workspaceId, userId)}
    ${conversationUnreadProbeLateral}
    ${conversationMentionLateral}
    WHERE ${taskItemListedSql(Prisma.sql`mention."firstId"`)}`;
}

export function taskUnreadAttentionRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT
      'conversation:' || cm."conversationId" AS "key",
      latest."createdAt" AS "latestAt",
      latest."sequence" AS "latestSequence"
    FROM ${taskItemsSql(workspaceId, userId)}
    LEFT JOIN LATERAL (
      SELECT TRUE AS "found" FROM "messages" m
      WHERE ${conversationUnreadMessageSql}
      ORDER BY m."sequence" LIMIT 1
    ) unread ON ${taskBoardReadableSql} AND ${conversationActiveUnreadGateSql}
    WHERE ${taskBoardReadableSql}
      AND ${conversationActiveUnreadGateSql}
      AND unread."found" IS NOT NULL
      AND (
        tf."taskId" IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM "message_mentions" mm
          JOIN "messages" m ON m."id" = mm."messageId" AND m."conversationId" = mm."conversationId"
          WHERE mm."memberId" = cm."id"
            AND m."threadRootId" IS NULL
            AND m."sequence" > COALESCE(cm."doneThroughSequence", 0)
        )
      )`;
}
