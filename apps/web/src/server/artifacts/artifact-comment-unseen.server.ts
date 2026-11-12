import type { Prisma, PrismaClient } from "#src/generated/prisma/client";

/** A place in an artifact's comments: the order they are listed in is (`createdAt`, `id`). */
export type CommentCursor = { at: Date; id: string };

/** A cursor as a page names it: the time as ISO, a `|`, the comment's id. */
const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const formatCursor = (cursor: CommentCursor) => `${cursor.at.toISOString()}|${cursor.id}`;

/** The cursor a page named, or `undefined` when the text is not one: a real time, and an id in
 * its one (lower-case) form, as a comment's id is stored. */
export function parseCursor(text: string): CommentCursor | undefined {
  const [, at, id] = CURSOR.exec(text) ?? [];
  if (!at || !id) return undefined;
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? undefined : { at: time, id: id.toLowerCase() };
}

/** The later of two places, either of which may be none. */
export function laterCursor(
  left: CommentCursor | null,
  right: CommentCursor | null,
): CommentCursor | null {
  if (!left || !right) return left ?? right;
  if (left.at.getTime() !== right.at.getTime()) return left.at > right.at ? left : right;
  return left.id >= right.id ? left : right;
}

/** Comments listed after a place (all of them for none). */
export const afterCursor = (cursor: CommentCursor | null): Prisma.ArtifactCommentWhereInput =>
  cursor
    ? { OR: [{ createdAt: { gt: cursor.at } }, { createdAt: cursor.at, id: { gt: cursor.id } }] }
    : {};

/** The last comment an Agent was shown on an artifact, or `null` when it has seen none. */
export async function commentPositionOf(
  db: Pick<PrismaClient, "artifactCommentPosition">,
  input: { artifactId: string; agentId: string },
): Promise<CommentCursor | null> {
  const row = await db.artifactCommentPosition.findUnique({
    where: { artifactId_agentId: { artifactId: input.artifactId, agentId: input.agentId } },
    select: { seenAt: true, seenId: true },
  });
  return row ? { at: row.seenAt, id: row.seenId } : null;
}

/**
 * Moves an Agent's comment position to the comment `commentId` (the last one it was shown), never
 * backwards. The time is read from the comment's own row, so the pair is exactly what listing
 * orders by.
 */
export async function advanceCommentPosition(
  db: Pick<PrismaClient, "$executeRaw">,
  input: { artifactId: string; agentId: string; commentId: string },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "artifact_comment_positions" ("artifactId", "agentId", "seenAt", "seenId")
    SELECT "artifactId", ${input.agentId}::uuid, "createdAt", "id"
    FROM "artifact_comments"
    WHERE "id" = ${input.commentId}::uuid AND "artifactId" = ${input.artifactId}::uuid
    ON CONFLICT ("artifactId", "agentId") DO UPDATE
    SET "seenAt" = EXCLUDED."seenAt", "seenId" = EXCLUDED."seenId"
    WHERE ("artifact_comment_positions"."seenAt", "artifact_comment_positions"."seenId")
      < (EXCLUDED."seenAt", EXCLUDED."seenId")`;
}

/**
 * The comments that are unseen to an Agent: written by someone else (a person, or another Agent;
 * an author that was removed is someone else), not deleted, after its comment position. The one
 * definition the unseen read, the read's summary and the gate share.
 */
export function unseenWhere(input: {
  artifactId: string;
  agentId: string;
  position: CommentCursor | null;
}): Prisma.ArtifactCommentWhereInput {
  return {
    AND: [
      { artifactId: input.artifactId, deletedAt: null },
      { OR: [{ authorAgentId: null }, { authorAgentId: { not: input.agentId } }] },
      afterCursor(input.position),
    ],
  };
}

/** The place a comment is at in the listing. */
export const cursorOf = (row: { createdAt: Date; id: string }): CommentCursor => ({
  at: row.createdAt,
  id: row.id,
});

/** The order comments are listed in. */
export const COMMENT_ORDER = [{ createdAt: "asc" }, { id: "asc" }] as const;
