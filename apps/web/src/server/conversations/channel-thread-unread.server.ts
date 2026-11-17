import { Prisma, type PrismaClient } from "#src/generated/prisma/client";

export type ChannelThreadUnreadSummary = {
  unreadThreadCount: number;
  threadMentioned: boolean;
};

function unreadReplyPredicate(memberIdSql: Prisma.Sql) {
  return Prisma.sql`m."senderMemberId" IS NOT NULL
    AND m."senderMemberId" IS DISTINCT FROM ${memberIdSql}
    AND m."sequence" > COALESCE(tr."readThroughSequence", 0)`;
}

const nonTaskThreadRootSql = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "tasks" t
  WHERE t."messageId" = tf."rootMessageId"
    AND t."conversationId" = tf."conversationId"
    AND t."deletedAt" IS NULL
)`;

export function workspaceChannelThreadUnreadsSql(workspaceId: string, userId: string) {
  return Prisma.sql`
    SELECT cm."conversationId" AS "conversationId",
      COUNT(*)::int AS "unreadThreadCount",
      COALESCE(BOOL_OR(unread_thread."mentioned"), FALSE) AS "threadMentioned"
    FROM "conversation_members" cm
    JOIN "conversations" c
      ON c."id" = cm."conversationId"
     AND c."workspaceId" = ${workspaceId}::uuid
     AND c."channelName" IS NOT NULL
     AND c."hiddenFromWorkspaceAt" IS NULL
    JOIN "thread_follows" tf
      ON tf."memberId" = cm."id"
     AND tf."conversationId" = cm."conversationId"
     AND tf."unfollowedAt" IS NULL
    LEFT JOIN "thread_reads" tr
      ON tr."memberId" = tf."memberId"
     AND tr."rootMessageId" = tf."rootMessageId"
    CROSS JOIN LATERAL (
      SELECT BOOL_OR(EXISTS (
        SELECT 1 FROM "message_mentions" mm
        WHERE mm."messageId" = m."id" AND mm."memberId" = cm."id"
        OFFSET 0
      )) AS "mentioned"
      FROM "messages" m
      WHERE m."conversationId" = tf."conversationId"
        AND m."threadRootId" = tf."rootMessageId"
        AND ${unreadReplyPredicate(Prisma.sql`cm."id"`)}
      HAVING COUNT(*) > 0
    ) unread_thread
    WHERE cm."userId" = ${userId}::uuid
      AND cm."leftAt" IS NULL
      AND cm."workspaceId" = ${workspaceId}::uuid
      AND ${nonTaskThreadRootSql}
    GROUP BY cm."conversationId"`;
}

export async function workspaceChannelThreadUnreads(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  workspaceId: string,
  userId: string,
): Promise<Map<string, ChannelThreadUnreadSummary>> {
  const rows = await db.$queryRaw<
    { conversationId: string; unreadThreadCount: number; threadMentioned: boolean }[]
  >(workspaceChannelThreadUnreadsSql(workspaceId, userId));
  return new Map(
    rows.map((row) => [
      row.conversationId,
      { unreadThreadCount: row.unreadThreadCount, threadMentioned: row.threadMentioned },
    ]),
  );
}

export async function channelThreadUnreadsForMembers(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  conversationId: string,
  memberIds: readonly string[],
): Promise<Map<string, ChannelThreadUnreadSummary>> {
  if (memberIds.length === 0) return new Map();
  const rows = await db.$queryRaw<
    { memberId: string; unreadThreadCount: number; threadMentioned: boolean }[]
  >`
    SELECT tf."memberId" AS "memberId",
      COUNT(*)::int AS "unreadThreadCount",
      COALESCE(BOOL_OR(unread_thread."mentioned"), FALSE) AS "threadMentioned"
    FROM "thread_follows" tf
    LEFT JOIN "thread_reads" tr
      ON tr."memberId" = tf."memberId"
     AND tr."rootMessageId" = tf."rootMessageId"
    CROSS JOIN LATERAL (
      SELECT BOOL_OR(EXISTS (
        SELECT 1 FROM "message_mentions" mm
        WHERE mm."messageId" = m."id" AND mm."memberId" = tf."memberId"
        OFFSET 0
      )) AS "mentioned"
      FROM "messages" m
      WHERE m."conversationId" = tf."conversationId"
        AND m."threadRootId" = tf."rootMessageId"
        AND ${unreadReplyPredicate(Prisma.sql`tf."memberId"`)}
      HAVING COUNT(*) > 0
    ) unread_thread
    WHERE tf."memberId" = ANY(${[...memberIds]}::uuid[])
      AND tf."conversationId" = ${conversationId}::uuid
      AND tf."unfollowedAt" IS NULL
      AND ${nonTaskThreadRootSql}
    GROUP BY tf."memberId"`;
  const byMember = new Map<string, ChannelThreadUnreadSummary>();
  for (const memberId of memberIds) {
    byMember.set(memberId, { unreadThreadCount: 0, threadMentioned: false });
  }
  for (const row of rows) {
    byMember.set(row.memberId, {
      unreadThreadCount: row.unreadThreadCount,
      threadMentioned: row.threadMentioned,
    });
  }
  return byMember;
}

export async function channelThreadUnreadsForUserConversations(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
  conversationIds: readonly string[],
): Promise<Map<string, ChannelThreadUnreadSummary>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await db.$queryRaw<
    { conversationId: string; unreadThreadCount: number; threadMentioned: boolean }[]
  >`
    SELECT cm."conversationId" AS "conversationId",
      COUNT(*)::int AS "unreadThreadCount",
      COALESCE(BOOL_OR(unread_thread."mentioned"), FALSE) AS "threadMentioned"
    FROM "conversation_members" cm
    JOIN "conversations" c
      ON c."id" = cm."conversationId"
     AND c."channelName" IS NOT NULL
    JOIN "thread_follows" tf
      ON tf."memberId" = cm."id"
     AND tf."conversationId" = cm."conversationId"
     AND tf."unfollowedAt" IS NULL
    LEFT JOIN "thread_reads" tr
      ON tr."memberId" = tf."memberId"
     AND tr."rootMessageId" = tf."rootMessageId"
    CROSS JOIN LATERAL (
      SELECT BOOL_OR(EXISTS (
        SELECT 1 FROM "message_mentions" mm
        WHERE mm."messageId" = m."id" AND mm."memberId" = cm."id"
        OFFSET 0
      )) AS "mentioned"
      FROM "messages" m
      WHERE m."conversationId" = tf."conversationId"
        AND m."threadRootId" = tf."rootMessageId"
        AND ${unreadReplyPredicate(Prisma.sql`cm."id"`)}
      HAVING COUNT(*) > 0
    ) unread_thread
    WHERE cm."userId" = ${userId}::uuid
      AND cm."conversationId" = ANY(${[...conversationIds]}::uuid[])
      AND cm."leftAt" IS NULL
      AND ${nonTaskThreadRootSql}
    GROUP BY cm."conversationId"`;
  return new Map(
    rows.map((row) => [
      row.conversationId,
      { unreadThreadCount: row.unreadThreadCount, threadMentioned: row.threadMentioned },
    ]),
  );
}

export async function isLegacyTaskThreadRoot(
  db: Pick<PrismaClient, "task">,
  conversationId: string,
  rootMessageId: string,
): Promise<boolean> {
  const found = await db.task.findFirst({
    where: { conversationId, messageId: rootMessageId, deletedAt: null },
    select: { id: true },
  });
  return found !== null;
}
