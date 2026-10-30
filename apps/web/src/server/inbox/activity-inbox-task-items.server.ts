import { Prisma } from "#src/generated/prisma/client";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import {
  conversationMentionLateral,
  conversationPastDoneSql,
  conversationUnreadLateral,
  conversationUnreadMessageSql,
} from "./activity-inbox-items-sql.server";

/**
 * The viewer's task conversations (`Conversation.kind` "task_thread") the Activity inbox can list,
 * as the `FROM` of an item query over the viewer's seat (`cm`) in the conversation (`c`), its task
 * (`t`), the task's channel board (`b`) and the viewer's own member row on it (`bm`). The board is
 * what lets them read: a public channel, or one they are on. A task on a direct board is not
 * listed.
 */
function taskItemsSql(workspaceId: string, userId: string) {
  return Prisma.sql`"conversation_members" cm
    JOIN "conversations" c
      ON c."id" = cm."conversationId"
     AND cm."userId" = ${userId}::uuid
     AND cm."workspaceId" = ${workspaceId}::uuid
     AND cm."leftAt" IS NULL
     AND c."kind" = 'task_thread'
    JOIN "tasks" t ON t."discussionConversationId" = c."id"
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

/** Read as the board's rule reads it: a public channel, or a member's. */
const taskBoardReadableSql = Prisma.sql`(b."visibility" = ${CHANNEL_VISIBILITY.PUBLIC} OR bm."id" IS NOT NULL)`;

/** Listed with activity past Done, for a task the viewer follows or was mentioned in. */
const taskItemListedSql = (mentionFirstId: Prisma.Sql) => Prisma.sql`${taskBoardReadableSql}
  AND ${conversationPastDoneSql}
  AND (tf."taskId" IS NOT NULL OR ${mentionFirstId} IS NOT NULL)`;

/** The list's task candidates, shaped as the conversation candidates are, plus the task. */
export function taskCandidatesSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT
      'channel' AS "kind",
      cm."id" AS "memberId",
      cm."conversationId" AS "conversationId",
      NULL::uuid AS "rootMessageId",
      b."channelName" AS "channelName",
      NULL::text AS "directKey",
      NULL::uuid AS "agentId",
      latest."id" AS "latestMessageId",
      latest."sequence" AS "latestSequence",
      latest."createdAt" AS "latestAt",
      unread."count" AS "unreadCount",
      unread."firstId" AS "firstUnreadMessageId",
      mention."unread" AS "unreadMention",
      mention."firstId" AS "firstMentionMessageId",
      TRUE AS "pastDone",
      NULL::int AS "pinOrder",
      NULL::timestamp AS "pinnedAt",
      b."id" AS "taskBoardId",
      t."number" AS "taskNumber",
      t."title" AS "taskTitle"
    FROM ${taskItemsSql(workspaceId, userId)}
    ${conversationUnreadLateral}
    ${conversationMentionLateral}
    WHERE ${taskItemListedSql(Prisma.sql`mention."firstId"`)}`;
}

/** Whether a listed task conversation has anything unread: the nav dot's term for them. */
export function taskHasUnreadSql(workspaceId: string, userId: string) {
  return Prisma.sql`SELECT 1 FROM ${taskItemsSql(workspaceId, userId)}
      ${conversationMentionLateral}
      CROSS JOIN LATERAL (
        SELECT 1 FROM "messages" m WHERE ${conversationUnreadMessageSql}
        ORDER BY m."sequence" LIMIT 1
      ) message
      WHERE ${taskItemListedSql(Prisma.sql`mention."firstId"`)}`;
}
