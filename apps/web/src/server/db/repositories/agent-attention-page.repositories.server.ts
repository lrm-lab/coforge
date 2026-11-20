import { Prisma } from "#src/generated/prisma/client";
import { readableArtifactNoticeSql } from "#src/server/artifacts/artifact-notice-visibility.server";
import { readableChannelSql } from "#src/server/conversations/channel-read-access.server";
import { directConversationSql } from "#src/server/conversations/active-member.server";

export function pendingDeliveryPageSql(
  workspaceId: string,
  agentId: string,
  selected: Prisma.Sql,
  limit: number,
): Prisma.Sql {
  const seat = (alias: string) => Prisma.sql`EXISTS (
    SELECT 1 FROM "conversation_members" seat
    WHERE seat."conversationId" = ${Prisma.raw(alias)}."id"
      AND seat."agentId" = ${agentId}::uuid AND seat."leftAt" IS NULL)`;
  const ordinaryTarget = (alias: string) => Prisma.sql`(
    ${Prisma.raw(alias)}."kind" IS NULL
    OR ${Prisma.raw(alias)}."kind" NOT IN ('task_thread', 'attachment_comments'))`;
  return Prisma.sql`
    SELECT d."deliveryId"
    FROM "agent_message_deliveries" d
    JOIN "messages" msg ON msg."id" = d."messageId"
    JOIN "conversations" c ON c."id" = d."conversationId" AND c."workspaceId" = d."workspaceId"
    WHERE d."workspaceId" = ${workspaceId}::uuid
      AND d."agentId" = ${agentId}::uuid
      AND ${selected}
      AND (d."receivedAt" IS NOT NULL OR d."expiresAt" IS NULL
        OR d."expiresAt" > (now() AT TIME ZONE 'UTC'))
      AND c."hiddenFromWorkspaceAt" IS NULL
      AND (
        c."channelName" IS NOT NULL
        OR ${directConversationSql("c")}
        OR c."kind" = 'attachment_comments'
        OR (c."kind" = 'task_thread' AND EXISTS (
          SELECT 1 FROM "tasks" task
          JOIN "conversations" board ON board."id" = task."conversationId"
          WHERE task."discussionConversationId" = c."id"
            AND (${readableChannelSql("board", workspaceId, { agentId })}
              OR (board."hiddenFromWorkspaceAt" IS NULL AND ${directConversationSql("board")}))))
      )
      AND (
        ${directConversationSql("c")}
        OR (${ordinaryTarget("c")} AND ${seat("c")})
        OR EXISTS (
          SELECT 1 FROM "tasks" followed
          WHERE followed."discussionConversationId" = c."id"
            AND EXISTS (
              SELECT 1 FROM "task_follows" follow
              JOIN "conversation_members" follower ON follower."id" = follow."memberId"
                AND follower."conversationId" = follow."conversationId"
                AND follower."workspaceId" = follow."workspaceId"
              WHERE follow."taskId" = followed."id"
                AND follow."conversationId" = followed."conversationId"
                AND follower."agentId" = ${agentId}::uuid
                AND follower."leftAt" IS NULL))
        OR (
          EXISTS (
            SELECT 1 FROM "attachment_comments" comment_row
            WHERE comment_row."messageId" = msg."id"
              AND comment_row."conversationId" = msg."conversationId")
          AND (
            (${ordinaryTarget("c")} AND ${seat("c")})
            OR (c."kind" = 'attachment_comments' AND EXISTS (
              SELECT 1 FROM "attachment_comment_threads" thread
              JOIN "attachments" attachment ON attachment."id" = thread."attachmentId"
                AND attachment."workspaceId" = thread."workspaceId"
              JOIN "conversations" source ON source."id" = attachment."conversationId"
                AND source."workspaceId" = attachment."workspaceId"
              WHERE thread."conversationId" = c."id"
                AND thread."workspaceId" = c."workspaceId"
                AND source."hiddenFromWorkspaceAt" IS NULL
                AND ${seat("source")}))))
        OR (${readableChannelSql("c", workspaceId, { agentId })} AND EXISTS (
          SELECT 1 FROM "pending_mention_actions" mention
          WHERE mention."messageId" = msg."id"
            AND mention."conversationId" = msg."conversationId"
            AND mention."targetAgentId" = ${agentId}::uuid
            AND mention."notifiedAt" IS NOT NULL))
      )
      AND ${readableArtifactNoticeSql(workspaceId, agentId, Prisma.sql`msg."id"`)}
    ORDER BY d."createdAt" ASC, d."deliveryId" ASC
    LIMIT ${limit}`;
}
