import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { readableChannelSql } from "#src/server/conversations/channel-read-access.server";
import { escapeLikeTerm } from "#src/lib/search-terms";

export type MessageSearchSort = "relevance" | "recent";

/**
 * How many of the newest matches a `relevance` search ranks. `word_similarity` and `similarity`
 * cost ~0.2ms per candidate row, so ranking every match of a common term in a large
 * conversation took ~400ms on production; the window keeps the ranked pool bounded. Matches
 * containing the whole query as one phrase join the pool at any age, and every match past the
 * pool still pages in `createdAt` order, so nothing is unreachable.
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
 * The `ILIKE` pattern for a body holding the whole query as one contiguous phrase, or null when
 * the query is a single word — then the phrase pattern is the term pattern itself and every
 * match would qualify, which would put the whole match set back into the ranked pool. Only a
 * multi-word query makes "contains the phrase" strictly narrower than "contains every term".
 */
function verbatimPattern(query: string): string | null {
  const phrase = query.trim().replace(/\s+/g, " ");
  return phrase.includes(" ") ? containsPattern(phrase) : null;
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
 * `relevance` scores only a bounded pool — the newest `MESSAGE_SEARCH_RELEVANCE_WINDOW`
 * matches plus, for a multi-word query, every match containing the whole phrase (the "I
 * remember the exact words" case, which the trigram index finds cheaply and which
 * `word_similarity` already ranks first). Everything past the pool still pages in `createdAt`
 * order, so an old message is never unreachable; with fewer matches than the window the pool
 * holds them all and the ranking is unchanged.
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

  if (criteria.sort !== "relevance" || criteria.terms.length === 0) {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT m."id"
      FROM ${source}
      WHERE ${where}
      ORDER BY m."createdAt" DESC, m."id" DESC
      LIMIT ${criteria.limit + 1} OFFSET ${criteria.offset}`;
    return rows.map((row) => row.id);
  }

  // The ranked pool: the newest windowed matches UNION every verbatim phrase match. Pool ids
  // are scored through a join back to `messages`, so `pg_trgm` runs on pool rows only.
  const pattern = verbatimPattern(criteria.query);
  const want = criteria.limit + 1;
  const windowedIds = Prisma.sql`"windowed" AS (
    SELECT m."id"
    FROM ${source}
    WHERE ${where}
    ORDER BY m."createdAt" DESC, m."id" DESC
    LIMIT ${MESSAGE_SEARCH_RELEVANCE_WINDOW})`;
  const verbatimIds = pattern
    ? Prisma.sql`, "verbatim" AS (
        SELECT m."id"
        FROM ${source}
        WHERE ${where} AND m."body" ILIKE ${pattern})`
    : Prisma.sql``;
  const poolUnion = pattern ? Prisma.sql` UNION SELECT "id" FROM "verbatim"` : Prisma.sql``;

  const ranked = await db.$queryRaw<{ id: string }[]>`
    WITH ${windowedIds}${verbatimIds},
    "pool" AS (SELECT "id" FROM "windowed"${poolUnion})
    SELECT m."id"
    FROM "pool" p
    JOIN "messages" m ON m."id" = p."id"
    ORDER BY word_similarity(${criteria.query}, m."body") DESC,
      similarity(${criteria.query}, m."body") DESC, m."createdAt" DESC, m."id" DESC
    LIMIT ${want} OFFSET ${criteria.offset}`;
  if (ranked.length === want) return ranked.map((row) => row.id);

  // Everything past the pool pages in `createdAt` order: the same filters and sender join,
  // minus the pool ids and minus verbatim hits (they already ranked).
  const tailIds = (limit: number, offset: number) =>
    db.$queryRaw<{ id: string }[]>`
      WITH ${windowedIds}
      SELECT m."id"
      FROM ${source}
      WHERE ${where}
        AND m."id" NOT IN (SELECT "id" FROM "windowed")
        ${pattern ? Prisma.sql`AND m."body" NOT ILIKE ${pattern}` : Prisma.sql``}
      ORDER BY m."createdAt" DESC, m."id" DESC
      LIMIT ${limit} OFFSET ${offset}`;

  if (ranked.length > 0) {
    // The page crosses the pool boundary: the ranked rows returned are the pool's tail, so the
    // rest of the page comes from the match tail after them.
    const tail = await tailIds(want - ranked.length, 0);
    return [...ranked.map((row) => row.id), ...tail.map((row) => row.id)];
  }

  // The offset is past the whole pool: count it once, then page the tail from there.
  const counted = await db.$queryRaw<{ count: number }[]>`
    WITH ${windowedIds}${verbatimIds}
    SELECT COUNT(*)::int AS "count"
    FROM (SELECT "id" FROM "windowed"${poolUnion}) "pool"`;
  const tail = await tailIds(want, Math.max(0, criteria.offset - (counted[0]?.count ?? 0)));
  return tail.map((row) => row.id);
}
