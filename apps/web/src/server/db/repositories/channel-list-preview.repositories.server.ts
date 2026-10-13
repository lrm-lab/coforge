import type { PrismaClient } from "#src/generated/prisma/client";

/** A channel's newest top-level message and the sender member row that wrote it, if any. */
export type LatestTopLevelRow = {
  conversationId: string;
  messageId: string;
  body: string;
  createdAt: Date;
  senderUserId: string | null;
  senderAgentId: string | null;
};

/** One active member of a channel, in join order. `kind` is which side of the row is set. */
export type ActiveMemberRow = {
  conversationId: string;
  userId: string | null;
  agentId: string | null;
};

/**
 * The newest top-level message of each listed channel, in one LATERAL per channel on
 * `messages(conversationId, sequence)`. A channel with no top-level message has no row.
 */
export async function latestTopLevelMessageRows(
  db: Pick<PrismaClient, "$queryRaw">,
  conversationIds: readonly string[],
) {
  if (conversationIds.length === 0) return [];
  return db.$queryRaw<LatestTopLevelRow[]>`
    SELECT c."id" AS "conversationId",
           latest."id" AS "messageId",
           latest."body" AS "body",
           latest."createdAt" AS "createdAt",
           sender."userId" AS "senderUserId",
           sender."agentId" AS "senderAgentId"
    FROM "conversations" c
    CROSS JOIN LATERAL (
      SELECT m."id", m."body", m."createdAt", m."senderMemberId" FROM "messages" m
      WHERE m."conversationId" = c."id"
        AND m."threadRootId" IS NULL
      ORDER BY m."sequence" DESC LIMIT 1
    ) latest
    LEFT JOIN "conversation_members" sender ON sender."id" = latest."senderMemberId"
    WHERE c."id" = ANY(${[...conversationIds]}::uuid[])
  `;
}

/**
 * The first `limit` active members of each listed channel, by join time then member id. A
 * soft-left member and a deleted Agent are not active. One LATERAL per channel, so the rows of
 * every channel load in one query.
 */
export async function activeMemberRows(
  db: Pick<PrismaClient, "$queryRaw">,
  conversationIds: readonly string[],
  limit: number,
) {
  if (conversationIds.length === 0) return [];
  return db.$queryRaw<ActiveMemberRow[]>`
    SELECT c."id" AS "conversationId",
           member."userId" AS "userId",
           member."agentId" AS "agentId"
    FROM "conversations" c
    CROSS JOIN LATERAL (
      SELECT cm."userId", cm."agentId" FROM "conversation_members" cm
      LEFT JOIN "agents" a ON a."id" = cm."agentId"
      WHERE cm."conversationId" = c."id"
        AND cm."leftAt" IS NULL
        AND (cm."agentId" IS NULL OR a."deletedAt" IS NULL)
      ORDER BY cm."joinedAt" ASC, cm."id" ASC
      LIMIT ${limit}
    ) member
    WHERE c."id" = ANY(${[...conversationIds]}::uuid[])
  `;
}
