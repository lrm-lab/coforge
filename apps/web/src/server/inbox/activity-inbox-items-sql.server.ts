import { Prisma } from "#src/generated/prisma/client";
import {
  HUMAN_UNREAD_BASE_SQL,
  directThreadsSql,
  followedChannelThreadsSql,
  humanUnreadReplySql,
} from "#src/server/conversations/human-unread.server";
import { readableChannelSql } from "#src/server/conversations/channel-read-access.server";
import { viewerDirectConversationSql } from "#src/server/conversations/viewer-direct-conversations.server";

/**
 * What the Activity inbox counts as an item, as SQL fragments: the viewer's joined conversations and
 * followed threads with their read and Done boundaries, and the unread and mention laterals over
 * them. The list and the nav dot share these, so they cannot disagree on what is listed or unread.
 */

/** A reply unread for the thread's viewer (the candidate query's `threads` and `tr` rows). */
const unreadReplySql = humanUnreadReplySql(
  Prisma.sql`threads."memberId"`,
  Prisma.sql`tr."readThroughSequence"`,
);

/** A top-level message unread for the viewer of a joined conversation (`cm`). The list counts these
 * and the nav dot probes for one, so the two share this definition. */
export const conversationUnreadMessageSql = Prisma.sql`m."conversationId" = cm."conversationId"
    AND m."threadRootId" IS NULL
    AND ${HUMAN_UNREAD_BASE_SQL}`;

/** A reply unread for the viewer of a followed thread: `thread` names the row with its
 * `memberId`, `conversationId` and `rootMessageId`, beside its cursors (`tr`). The list probes for
 * one, counts them on its page, and the nav dot probes for one, so all three share this. */
export function threadUnreadReplySql(thread: string) {
  const row = Prisma.raw(thread);
  return Prisma.sql`m."conversationId" = ${row}."conversationId"
    AND m."threadRootId" = ${row}."rootMessageId"
    AND ${humanUnreadReplySql(Prisma.sql`${row}."memberId"`, Prisma.sql`tr."readThroughSequence"`)}`;
}

/**
 * Whether an item has anything unread, as a lateral (`unread`) that stops at the first unread row:
 * every item is probed, and only the page's items are counted (`activity-inbox-page-sql.server.ts`).
 * Ordered by `sequence` so the read cursor's index range is the plan, as the nav dot's probes are.
 */
function unreadProbeLateral(unreadMessage: Prisma.Sql) {
  return Prisma.sql`LEFT JOIN LATERAL (
  SELECT TRUE AS "found" FROM "messages" m
  WHERE ${unreadMessage}
  ORDER BY m."sequence" LIMIT 1
) unread ON TRUE`;
}

/** A joined conversation's (`cm`) unread probe. */
export const conversationUnreadProbeLateral = unreadProbeLateral(conversationUnreadMessageSql);

/**
 * A joined conversation's mention lateral (`mention`): the first message past Done that mentions
 * the viewer, and whether one of them is unread. It names the `cm` its `FROM` provides.
 */
export const conversationMentionLateral = Prisma.sql`CROSS JOIN LATERAL (
  SELECT COALESCE(BOOL_OR(${HUMAN_UNREAD_BASE_SQL}), FALSE) AS "unread",
    (ARRAY_AGG(m."id" ORDER BY m."sequence"))[1] AS "firstId"
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
  JOIN "message_mentions" mm
    ON mm."messageId" = m."id"
   AND mm."memberId" = threads."memberId"
   AND mm."conversationId" = m."conversationId"
  WHERE m."conversationId" = threads."conversationId"
    AND m."threadRootId" = threads."rootMessageId"
    AND m."sequence" > COALESCE(tr."doneThroughSequence", 0)
) mention`;

/**
 * The viewer's joined conversations with their newest top-level message (`latest`), as the `FROM` of
 * an item query over `cm` and `c`. The list and the nav dot share it, so they cannot disagree on what
 * is listed; the list adds `conversationPeerLateral` for the DM's Agent it shows.
 */
function conversationItemsSql(workspaceId: string, userId: string) {
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

/** A conversation item's DM Agent (`peer`), which the list shows and the nav dot does not need. */
const conversationPeerLateral = Prisma.sql`LEFT JOIN LATERAL (
  SELECT am."agentId" FROM "conversation_members" am
  JOIN "agents" a ON a."id" = am."agentId" AND a."deletedAt" IS NULL
  WHERE am."conversationId" = cm."conversationId" AND am."agentId" IS NOT NULL
  LIMIT 1
) peer ON c."directKey" IS NOT NULL`;

/** A joined conversation the inbox can list: a channel, or one of the viewer's own DMs (the ones
 * their Direct messages list holds). */
function conversationItemVisibleSql(userId: string) {
  return Prisma.sql`(c."channelName" IS NOT NULL OR ${viewerDirectConversationSql(userId)})`;
}

/** A joined conversation's newest top-level message is past the viewer's Done boundary. */
export const conversationPastDoneSql = Prisma.sql`(latest."sequence" > COALESCE(cm."doneThroughSequence", 0))`;

/** A joined conversation is listed when the inbox can list it and it has activity past Done. */
function conversationItemListedSql(userId: string) {
  return Prisma.sql`${conversationItemVisibleSql(userId)} AND ${conversationPastDoneSql}`;
}

/**
 * The viewer's followed channel threads and direct-message threads (`threads`) with their
 * conversation (`c`), thread cursors (`tr`) and newest reply (`latest`), as the `FROM` of an item
 * query. `threadItemListedSql` is its `WHERE`; the list adds `threadPeerLateral`.
 */
function threadItemsSql(workspaceId: string, userId: string) {
  return Prisma.sql`(
      SELECT 'channel' AS "kind", followed.* FROM (${followedChannelThreadsSql(workspaceId, userId)}) followed
      UNION ALL
      SELECT 'direct' AS "kind", direct.* FROM (${directThreadsSql(workspaceId, userId)}) direct
    ) threads
    JOIN "conversations" c ON c."id" = threads."conversationId"
    LEFT JOIN "thread_reads" tr
      ON tr."memberId" = threads."memberId" AND tr."rootMessageId" = threads."rootMessageId"
    CROSS JOIN LATERAL (
      SELECT m."id", m."sequence", m."createdAt" FROM "messages" m
      WHERE m."conversationId" = threads."conversationId"
        AND m."threadRootId" = threads."rootMessageId"
      ORDER BY m."sequence" DESC LIMIT 1
    ) latest`;
}

/** A direct-message thread item's Agent (`peer`), which the list shows and the nav dot does not need. */
const threadPeerLateral = Prisma.sql`LEFT JOIN LATERAL (
  SELECT am."agentId" FROM "conversation_members" am
  JOIN "agents" a ON a."id" = am."agentId" AND a."deletedAt" IS NULL
  WHERE threads."kind" = 'direct'
    AND am."conversationId" = threads."conversationId"
    AND am."agentId" IS NOT NULL
  LIMIT 1
) peer ON TRUE`;

/** A thread is listed with a reply past Done; a direct-message thread only in the viewer's own DMs. */
function threadItemListedSql(userId: string) {
  return Prisma.sql`latest."sequence" > COALESCE(tr."doneThroughSequence", 0)
    AND (threads."kind" = 'channel' OR ${viewerDirectConversationSql(userId)})`;
}

/** A notification sent to the viewer and not yet Done (`pma`): the list's notice items and the
 * nav dot's notice terms. */
export function pendingNoticeSql(workspaceId: string, userId: string) {
  return Prisma.sql`pma."workspaceId" = ${workspaceId}::uuid
    AND pma."targetUserId" = ${userId}::uuid
    AND pma."notifiedAt" IS NOT NULL
    AND pma."dismissedAt" IS NULL`;
}

/**
 * A comment notification's file source (`src`) the viewer still reads: a public channel, or a
 * conversation they are an active member of, neither hidden nor archived. Never the comment
 * conversation's seats: a comment conversation is no channel and no DM.
 */
export function commentSourceReadableSql(userId: string) {
  return Prisma.sql`src."hiddenFromWorkspaceAt" IS NULL AND src."archivedAt" IS NULL
    AND ((src."channelName" IS NOT NULL AND src."visibility" = 'public')
      OR EXISTS (
        SELECT 1 FROM "conversation_members" scm
        WHERE scm."conversationId" = src."id" AND scm."userId" = ${userId}::uuid
          AND scm."leftAt" IS NULL))`;
}

/**
 * The nav rail's Activity statement: whether the viewer has any unread activity, over the same three
 * terms the inbox lists — joined conversations, followed threads, notified mentions and (`taskTerm`,
 * from `activity-inbox-task-items.server.ts`) task conversations — each from
 * the item's own read boundary up. The dot needs no count, so each term is an `EXISTS` that stops at
 * the first unread row. Conversations and threads probe through a lateral keyed on their row, ordered
 * by `sequence` so the read cursor's index range is the plan: a plain join, or a bare `LIMIT 1`,
 * let the planner expect an early stop and scan all of `messages` when nothing is unread.
 */
export function navHasUnreadSql(workspaceId: string, userId: string, taskTerm: Prisma.Sql) {
  return Prisma.sql`
    SELECT (EXISTS (
      -- A notified mention is unread until the viewer reads it; the cheapest term goes first.
      SELECT 1 FROM "pending_mention_actions" pma
      JOIN "conversations" pc ON pc."id" = pma."conversationId"
       AND pc."archivedAt" IS NULL AND ${readableChannelSql("pc", workspaceId, { userId })}
      WHERE ${pendingNoticeSql(workspaceId, userId)} AND pma."targetReadAt" IS NULL
    ) OR EXISTS (
      -- An attachment-comment notification, authorized like the inbox's comment branch: through
      -- the file's source conversation (channel by canReadChannel, DM as its active member),
      -- never the comment conversation's seats.
      SELECT 1 FROM "pending_mention_actions" pma
      JOIN "attachment_comments" pac ON pac."messageId" = pma."messageId"
      JOIN "attachments" att ON att."id" = pac."attachmentId"
      JOIN "conversations" src ON src."id" = att."conversationId"
       AND ${commentSourceReadableSql(userId)}
      WHERE ${pendingNoticeSql(workspaceId, userId)} AND pma."targetReadAt" IS NULL
    ) OR EXISTS (
      SELECT 1 FROM ${conversationItemsSql(workspaceId, userId)}
      CROSS JOIN LATERAL (
        SELECT 1 FROM "messages" m WHERE ${conversationUnreadMessageSql}
        ORDER BY m."sequence" LIMIT 1
      ) message
      WHERE ${conversationItemListedSql(userId)}
    ) OR EXISTS (
      ${taskTerm}
    ) OR EXISTS (
      SELECT 1 FROM ${threadItemsSql(workspaceId, userId)}
      CROSS JOIN LATERAL (
        SELECT 1 FROM "messages" m WHERE ${threadUnreadReplySql("threads")}
        ORDER BY m."sequence" LIMIT 1
      ) reply
      WHERE ${threadItemListedSql(userId)}
    )) AS "hasUnread"`;
}

/**
 * The columns every item row of the list carries, in the order the page statement unions them
 * (`activity-inbox-page-sql.server.ts`). Each item statement names all of them; the ones its kind
 * has none of are typed NULLs (`noTaskColumns`, `noNoticeColumns`).
 */
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
    "agentId",
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

/** The task columns of an item that is not a task conversation. */
export const noTaskColumns = Prisma.sql`NULL::uuid AS "taskBoardId", NULL::int AS "taskNumber",
  NULL::text AS "taskTitle"`;

/** The notification columns of an item that is not a mention or comment notification. */
export const noNoticeColumns = Prisma.sql`NULL::uuid AS "mentionId",
  NULL::uuid AS "noticeThreadRootId", NULL::uuid AS "attachmentId",
  NULL::text AS "attachmentFileName", NULL::uuid AS "attachmentSourceMessageId"`;

/**
 * The list's conversation items: every listed joined conversation, and every pinned one, with its
 * DM Agent, newest message, whether anything is unread, its mentions and its pin.
 */
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
      peer."agentId" AS "agentId",
      latest."id" AS "latestMessageId",
      latest."sequence" AS "latestSequence",
      latest."createdAt" AS "latestAt",
      ${conversationPastDoneSql} AS "pastDone",
      pin."sortOrder" AS "pinOrder",
      pin."createdAt" AS "pinnedAt",
      unread."found" IS NOT NULL AS "hasUnread",
      mention."unread" AS "unreadMention",
      mention."firstId" AS "firstMentionMessageId",
      ${noTaskColumns},
      ${noNoticeColumns}
    FROM ${conversationItemsSql(workspaceId, userId)}
    ${conversationPeerLateral}
    LEFT JOIN "conversation_pins" pin
      ON pin."workspaceId" = ${workspaceId}::uuid
     AND pin."memberId" = cm."id"
     AND pin."conversationId" = cm."conversationId"
    ${conversationUnreadProbeLateral}
    ${conversationMentionLateral}
    WHERE ${conversationItemVisibleSql(userId)}
      AND (${conversationPastDoneSql} OR pin."memberId" IS NOT NULL)`;
}

/** The list's thread items: every listed followed thread with its DM Agent, newest reply,
 * whether a reply is unread, and its mentions. */
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
      peer."agentId" AS "agentId",
      latest."id" AS "latestMessageId",
      latest."sequence" AS "latestSequence",
      latest."createdAt" AS "latestAt",
      TRUE AS "pastDone",
      NULL::int AS "pinOrder",
      NULL::timestamp AS "pinnedAt",
      unread."found" IS NOT NULL AS "hasUnread",
      mention."unread" AS "unreadMention",
      mention."firstId" AS "firstMentionMessageId",
      ${noTaskColumns},
      ${noNoticeColumns}
    FROM ${threadItemsSql(workspaceId, userId)}
    ${threadPeerLateral}
    ${unreadProbeLateral(threadUnreadReplySql("threads"))}
    ${threadMentionLateral}
    WHERE ${threadItemListedSql(userId)}`;
}
