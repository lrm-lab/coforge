import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { readableChannelSql } from "#src/server/conversations/channel-read-access.server";
import { escapeLikeTerm } from "#src/lib/search-terms";

export type MessageSearchSort = "relevance" | "recent";

/**
 * How many of the newest matches a `relevance` search ranks. `word_similarity` and `similarity`
 * cost ~0.2ms per candidate row, so ranking every match of a common term in a large
 * conversation took ~400ms on production; past the window the oldest matches are not candidates
 * at all. A query with fewer matches ranks exactly as before.
 */
export const MESSAGE_SEARCH_RELEVANCE_WINDOW = 500;

export type MessageSearchCriteria = {
  workspaceId: string;
  /** The human searching; only conversations they may read are searched. */
  viewerUserId: string;
  /** Whitespace-separated terms; every term must appear in the body. Empty: no text match. */
  terms: string[];
  /** The raw query `relevance` ranks against. */
  query: string;
  /** A sender's user or Agent id. */
  senderId?: string;
  senderKind?: "user" | "agent";
  mentionsViewer?: boolean;
  conversationId?: string;
  threadRootId?: string;
  after?: Date;
  before?: Date;
  sort: MessageSearchSort;
  limit: number;
  offset: number;
};

/** `ILIKE` treats `\`, `%` and `_` as syntax; escape them so every term matches literally. */
function containsPattern(term: string): string {
  return `%${escapeLikeTerm(term)}%`;
}

/**
 * Ids of the messages matching a search, in result order, one row past `limit` so the caller
 * can tell whether another page exists.
 *
 * Raw SQL because ranking uses `pg_trgm`, which Prisma cannot express: `word_similarity` scores
 * how closely some stretch of the body matches the query, and `similarity` breaks its ties in
 * favour of bodies where the query makes up more of the text (short, focused messages). The
 * body match is `ILIKE`, which the trigram GIN index `messages_body_idx` serves for terms of
 * three or more characters; shorter terms scan the Workspace's messages.
 *
 * `relevance` ranks only the newest `MESSAGE_SEARCH_RELEVANCE_WINDOW` matches: the two
 * similarity functions run per candidate row, so an unbounded rank over a common term in a
 * large conversation took ~400ms on production. With fewer matches the window holds them all
 * and the ranking is unchanged; past it the oldest matches are not candidates.
 *
 * A human may read every public channel in the Workspace (joined, left or never joined, archived
 * too), the private ones they are in (`readableChannelSql`), and only the direct conversations
 * they belong to, the same rule `ConversationHistory.authorize` applies to a single
 * conversation. System rows have no sender and are never results.
 */
export async function findMessageSearchIds(
  db: PrismaClient,
  criteria: MessageSearchCriteria,
): Promise<string[]> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`m."workspaceId" = ${criteria.workspaceId}::uuid`,
    // A channel is searched only by those who may read it (hidden and private ones included).
    Prisma.sql`(${readableChannelSql("c", criteria.workspaceId, { userId: criteria.viewerUserId })}
      OR c."directKey" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "conversation_members" v
      WHERE v."conversationId" = c."id" AND v."userId" = ${criteria.viewerUserId}::uuid))`,
    ...criteria.terms.map((term) => Prisma.sql`m."body" ILIKE ${containsPattern(term)}`),
  ];
  if (criteria.senderId) {
    conditions.push(
      Prisma.sql`(s."userId" = ${criteria.senderId}::uuid OR s."agentId" = ${criteria.senderId}::uuid)`,
    );
  }
  if (criteria.senderKind === "user") conditions.push(Prisma.sql`s."userId" IS NOT NULL`);
  if (criteria.senderKind === "agent") conditions.push(Prisma.sql`s."agentId" IS NOT NULL`);
  if (criteria.mentionsViewer) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "message_mentions" mm
      WHERE mm."messageId" = m."id" AND mm."kind" = 'user'
        AND mm."actorId" = ${criteria.viewerUserId}::uuid)`);
  }
  if (criteria.conversationId) {
    conditions.push(Prisma.sql`m."conversationId" = ${criteria.conversationId}::uuid`);
  }
  if (criteria.threadRootId)
    conditions.push(Prisma.sql`m."threadRootId" = ${criteria.threadRootId}::uuid`);
  if (criteria.after) conditions.push(Prisma.sql`m."createdAt" >= ${criteria.after}`);
  if (criteria.before) conditions.push(Prisma.sql`m."createdAt" < ${criteria.before}`);

  const source = Prisma.sql`"messages" m
    JOIN "conversations" c ON c."id" = m."conversationId"
    JOIN "conversation_members" s ON s."id" = m."senderMemberId"`;
  const where = Prisma.join(conditions, " AND ");
  const rows =
    criteria.sort === "relevance" && criteria.terms.length > 0
      ? await db.$queryRaw<{ id: string }[]>`
          WITH "windowed" AS (
            SELECT m."id", m."body", m."createdAt"
            FROM ${source}
            WHERE ${where}
            ORDER BY m."createdAt" DESC, m."id" DESC
            LIMIT ${MESSAGE_SEARCH_RELEVANCE_WINDOW}
          )
          SELECT w."id"
          FROM "windowed" w
          ORDER BY word_similarity(${criteria.query}, w."body") DESC,
            similarity(${criteria.query}, w."body") DESC, w."createdAt" DESC, w."id" DESC
          LIMIT ${criteria.limit + 1} OFFSET ${criteria.offset}`
      : await db.$queryRaw<{ id: string }[]>`
          SELECT m."id"
          FROM ${source}
          WHERE ${where}
          ORDER BY m."createdAt" DESC, m."id" DESC
          LIMIT ${criteria.limit + 1} OFFSET ${criteria.offset}`;
  return rows.map((row) => row.id);
}
