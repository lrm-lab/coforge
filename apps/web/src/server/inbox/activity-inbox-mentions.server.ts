import { Prisma } from "#src/generated/prisma/client";
import { readableChannelSql } from "#src/server/conversations/channel-read-access.server";
import {
  commentSourceReadableSql,
  noTaskColumns,
  pendingNoticeSql,
} from "./activity-inbox-items-sql.server";

/**
 * The mention notifications the Activity inbox lists, as item rows of its page statement: one item
 * per notification, until the viewer marks it Done.
 */

/**
 * The columns a notice item takes from its notification (`pma`) and message (`m`): listed from when
 * it was sent, unread until the viewer reads it.
 */
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

/**
 * Each message whose sender had the viewer notified of a mention from outside its channel. Not in
 * a hidden or archived channel, nor one the viewer can no longer read. Sender-actionable rows only:
 * a comment notification (reason set) is `commentNoticeRowsSql`'s, under the same `mention:<id>`
 * key, so admitting it here would shadow the attachment-comment item.
 */
export function mentionNoticeRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT ${noticeColumns},
      'channel' AS "kind",
      pma."conversationId" AS "conversationId",
      pc."channelName" AS "channelName",
      pc."visibility" AS "visibility",
      NULL::text AS "directKey",
      NULL::uuid AS "agentId",
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

/**
 * Each comment on a file that notified the viewer. It names the file's source conversation, not
 * the comment conversation, and is listed while the viewer still reads that source
 * (`commentSourceReadableSql`). The source is reached through `attachment_comments.attachmentId →
 * attachments` rather than the comment thread row: comment migration deletes
 * `attachment_comment_threads`.
 */
export function commentNoticeRowsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT ${noticeColumns},
      CASE WHEN src."channelName" IS NOT NULL THEN 'channel' ELSE 'direct' END AS "kind",
      src."id" AS "conversationId",
      src."channelName" AS "channelName",
      src."visibility" AS "visibility",
      src."directKey" AS "directKey",
      peer."agentId" AS "agentId",
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
    LEFT JOIN LATERAL (
      SELECT am."agentId" FROM "conversation_members" am
      WHERE am."conversationId" = src."id" AND am."agentId" IS NOT NULL
      LIMIT 1
    ) peer ON TRUE
    WHERE ${pendingNoticeSql(workspaceId, userId)}`;
}
