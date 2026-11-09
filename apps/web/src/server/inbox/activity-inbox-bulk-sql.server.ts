import { Prisma } from "#src/generated/prisma/client";
import {
  conversationItemListedSql,
  conversationItemsSql,
  conversationMentionLateral,
  threadItemListedSql,
  threadItemsSql,
} from "./activity-inbox-items-sql.server";
import { taskItemListedSql, taskItemsSql } from "./activity-inbox-task-items.server";

/**
 * The Activity inbox's Mark all done statements, and the ones that take it back. Each Done statement
 * takes a `target`: the member rows (or threads) to move, the boundary for each and the Done
 * boundary they held, found by the inbox's own listing fragments.
 */

/** What a conversation Done statement returns for each member row it touched. */
export type ConversationDoneRow = {
  memberId: string;
  conversationId: string;
  /** The Done boundary before the write; null when the row was never Done. */
  previous: number | null;
  /** The Done boundary the write left, which Undo compares before restoring. */
  through: number;
  readMoved: boolean;
  channel: boolean;
  task: boolean;
};

/** What a thread Done statement returns for each thread row it touched. */
export type ThreadDoneRow = {
  memberId: string;
  rootMessageId: string;
  previous: number | null;
  through: number;
};

/**
 * Moves member rows Done through `boundary` and reads them through it, consuming a mark-unread
 * marker at or below it, as `markConversationDoneSql` does for one row. `target` selects
 * `memberId`, `conversationId`, `previous`, `readThrough`, `unreadFrom` and `boundary`.
 */
export function conversationsDoneSql(target: Prisma.Sql) {
  return Prisma.sql`
    WITH target AS (${target})
    UPDATE "conversation_members" cm
    SET "readThroughSequence" = GREATEST(cm."readThroughSequence", target."boundary"),
        "unreadFromSequence" = CASE
          WHEN cm."unreadFromSequence" <= target."boundary" THEN NULL
          ELSE cm."unreadFromSequence" END,
        "doneThroughSequence" = GREATEST(COALESCE(cm."doneThroughSequence", 0), target."boundary")
    FROM target
    JOIN "conversations" c ON c."id" = target."conversationId"
    WHERE cm."id" = target."memberId"
    RETURNING cm."id" AS "memberId", cm."conversationId" AS "conversationId",
      target."previous" AS "previous", cm."doneThroughSequence" AS "through",
      (target."readThrough" < target."boundary"
        OR (target."unreadFrom" IS NOT NULL AND target."unreadFrom" <= target."boundary")) AS "readMoved",
      c."channelName" IS NOT NULL AS "channel", c."kind" = 'task_thread' AS "task"`;
}

/**
 * Moves threads Done through `boundary` and reads them through it, as `markThreadDoneSql` does for
 * one. `target` selects `memberId`, `conversationId`, `rootMessageId`, `previous` and `boundary`.
 */
export function threadsDoneSql(workspaceId: string, target: Prisma.Sql) {
  return Prisma.sql`
    WITH target AS (${target})
    INSERT INTO "thread_reads"
      ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence",
       "doneThroughSequence")
    SELECT target."memberId", target."conversationId", ${workspaceId}::uuid,
      target."rootMessageId", target."boundary", target."boundary"
    FROM target
    ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET
      "readThroughSequence" = GREATEST("thread_reads"."readThroughSequence", EXCLUDED."readThroughSequence"),
      "doneThroughSequence" =
        GREATEST(COALESCE("thread_reads"."doneThroughSequence", 0), EXCLUDED."doneThroughSequence")
    RETURNING "memberId", "rootMessageId", "doneThroughSequence" AS "through",
      (SELECT t."previous" FROM target t
        WHERE t."memberId" = "thread_reads"."memberId"
          AND t."rootMessageId" = "thread_reads"."rootMessageId") AS "previous"`;
}

/**
 * Every listed item's conversation target for Mark all done: the joined conversations and task
 * conversations the inbox lists, through their newest top-level message posted at or before
 * `before`. An item whose newest message came later stays listed.
 */
export function allConversationsTargetSql(workspaceId: string, userId: string, before: Date) {
  return Prisma.sql`
    WITH listed AS (
      SELECT cm."id" AS "memberId"
      FROM ${conversationItemsSql(workspaceId, userId)}
      WHERE ${conversationItemListedSql(userId)}
      UNION
      SELECT cm."id" AS "memberId"
      FROM ${taskItemsSql(workspaceId, userId)}
      ${conversationMentionLateral}
      WHERE ${taskItemListedSql(Prisma.sql`mention."firstId"`)}
    )
    SELECT cm."id" AS "memberId", cm."conversationId", cm."doneThroughSequence" AS "previous",
      cm."readThroughSequence" AS "readThrough", cm."unreadFromSequence" AS "unreadFrom",
      upto."sequence" AS "boundary"
    FROM listed
    JOIN "conversation_members" cm ON cm."id" = listed."memberId"
    CROSS JOIN LATERAL (
      SELECT m."sequence" FROM "messages" m
      WHERE m."conversationId" = cm."conversationId" AND m."threadRootId" IS NULL
        AND m."createdAt" <= ${before}
      ORDER BY m."sequence" DESC LIMIT 1
    ) upto
    WHERE COALESCE(cm."doneThroughSequence", 0) < upto."sequence"`;
}

/** Every listed thread's target for Mark all done, through its newest reply at or before `before`. */
export function allThreadsTargetSql(workspaceId: string, userId: string, before: Date) {
  return Prisma.sql`
    WITH listed AS (
      SELECT DISTINCT ON (threads."memberId", threads."rootMessageId")
        threads."memberId", threads."conversationId", threads."rootMessageId",
        tr."doneThroughSequence" AS "previous"
      FROM ${threadItemsSql(workspaceId, userId)}
      WHERE ${threadItemListedSql(userId)}
    )
    SELECT listed."memberId", listed."conversationId", listed."rootMessageId", listed."previous",
      upto."sequence" AS "boundary"
    FROM listed
    CROSS JOIN LATERAL (
      SELECT m."sequence" FROM "messages" m
      WHERE m."conversationId" = listed."conversationId"
        AND m."threadRootId" = listed."rootMessageId"
        AND m."createdAt" <= ${before}
      ORDER BY m."sequence" DESC LIMIT 1
    ) upto
    WHERE COALESCE(listed."previous", 0) < upto."sequence"`;
}

/**
 * Puts back the Done boundaries a bulk write replaced, each only where the row still holds exactly
 * what that write left (a newer Done since then stays), and only on the caller's own member rows.
 * A restored `previous` of 0 stands for "never Done": sequences start at 1, so 0 cannot be a real
 * boundary and the arrays need no NULLs.
 */
export function restoreConversationsDoneSql(
  workspaceId: string,
  userId: string,
  rows: { memberId: string; previous: number | null; through: number }[],
) {
  return Prisma.sql`
    UPDATE "conversation_members" cm
    SET "doneThroughSequence" = NULLIF(undo."previous", 0)
    FROM unnest(${rows.map((row) => row.memberId)}::uuid[],
      ${rows.map((row) => row.previous ?? 0)}::int[],
      ${rows.map((row) => row.through)}::int[]) AS undo("memberId", "previous", "through")
    WHERE cm."id" = undo."memberId"
      AND cm."userId" = ${userId}::uuid
      AND cm."workspaceId" = ${workspaceId}::uuid
      AND cm."doneThroughSequence" = undo."through"`;
}

/** The thread counterpart of `restoreConversationsDoneSql`. */
export function restoreThreadsDoneSql(
  workspaceId: string,
  userId: string,
  rows: { memberId: string; rootMessageId: string; previous: number | null; through: number }[],
) {
  return Prisma.sql`
    UPDATE "thread_reads" tr
    SET "doneThroughSequence" = NULLIF(undo."previous", 0)
    FROM unnest(${rows.map((row) => row.memberId)}::uuid[],
      ${rows.map((row) => row.rootMessageId)}::uuid[],
      ${rows.map((row) => row.previous ?? 0)}::int[],
      ${rows.map((row) => row.through)}::int[])
      AS undo("memberId", "rootMessageId", "previous", "through")
    JOIN "conversation_members" cm
      ON cm."id" = undo."memberId" AND cm."userId" = ${userId}::uuid
     AND cm."workspaceId" = ${workspaceId}::uuid
    WHERE tr."memberId" = cm."id"
      AND tr."rootMessageId" = undo."rootMessageId"
      AND tr."doneThroughSequence" = undo."through"`;
}
