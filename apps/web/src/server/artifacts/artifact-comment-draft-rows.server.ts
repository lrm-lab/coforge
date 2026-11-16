import { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { PersonAnchor } from "./artifact-comment-thread-reads.server";
import type { PreparedImage } from "./artifact-comment-images.server";
import type { CommentTx } from "./artifact-comment-write.server";

export const COMMENT_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const draftExpiryFrom = (now: Date) => new Date(now.getTime() + COMMENT_DRAFT_TTL_MS);

export const DRAFT_SELECT = {
  id: true,
  version: true,
  path: true,
  anchor: true,
  replyTo: true,
  body: true,
  images: true,
  createdAt: true,
  expiresAt: true,
} as const;

export type DraftRow = Prisma.ArtifactCommentDraftGetPayload<{ select: typeof DRAFT_SELECT }>;

export type DraftImageView = Omit<PreparedImage, "sha256"> & { position: number };

export type DraftView = {
  id: string;
  version: number;
  path: string | null;
  anchor: PersonAnchor | null;
  replyTo: string | null;
  body: string;
  images: DraftImageView[];
  createdAt: Date;
  expiresAt: Date;
};

export const imagesOf = (row: Pick<DraftRow, "images">) => row.images as unknown as PreparedImage[];

export function draftView(row: DraftRow): DraftView {
  return {
    id: row.id,
    version: row.version,
    path: row.path,
    anchor: row.anchor as PersonAnchor | null,
    replyTo: row.replyTo,
    body: row.body,
    images: imagesOf(row).map(({ sha256: _sha256, ...image }, position) => ({
      ...image,
      position,
    })),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export const draftNotFound = () =>
  new AppError("NOT_FOUND", {
    errorId: "artifact-draft-not-found",
    hint: "this artifact has none of your drafts with that id",
  });

export const draftsChanged = () =>
  new AppError("CONFLICT", {
    errorId: "artifact-drafts-changed",
    hint: "your drafts are not the ones sent: read them again",
  });

export const lockDrafts = (tx: CommentTx, artifactId: string, userId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`artifact-drafts:${artifactId}:${userId}`}, 0))`;

export async function lockedDrafts(
  tx: CommentTx,
  input: { artifactId: string; userId: string; now: Date; ids?: readonly string[] },
): Promise<DraftRow[]> {
  const only = input.ids ? Prisma.sql`AND "id" = ANY(${[...input.ids]}::uuid[])` : Prisma.empty;
  return tx.$queryRaw<DraftRow[]>`
    SELECT "id", "version", "path", "anchor", "replyTo", "body", "images", "createdAt", "expiresAt"
    FROM "artifact_comment_drafts"
    WHERE "artifactId" = ${input.artifactId}::uuid AND "userId" = ${input.userId}::uuid
      AND "expiresAt" > ${input.now} ${only}
    ORDER BY "createdAt", "id"
    FOR UPDATE`;
}
