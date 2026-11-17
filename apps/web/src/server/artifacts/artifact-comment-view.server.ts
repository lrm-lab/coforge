import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  actorDirectory,
  actorNames,
  actorOf,
  type ArtifactActorName,
} from "./artifact-actor-names.server";

export const COMMENT_SELECT = {
  id: true,
  version: true,
  path: true,
  anchor: true,
  rootId: true,
  reviewId: true,
  authorUserId: true,
  authorAgentId: true,
  body: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  resolvedAt: true,
  resolvedByUserId: true,
  resolvedByAgentId: true,
} as const;

export type CommentRow = Prisma.ArtifactCommentGetPayload<{ select: typeof COMMENT_SELECT }>;

export type ArtifactCommentView = {
  id: string;
  author: ArtifactActorName;
  version: number;
  path: string | null;
  anchor: unknown;
  replyTo: string | null;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  reviewId: string | null;
  images: ArtifactCommentImageView[];
  resolvedAt: Date | null;
  resolvedBy: ArtifactActorName | null;
};

export type ArtifactCommentImageView = {
  id: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
};

export type DeletedCommentView = Omit<
  ArtifactCommentView,
  "body" | "anchor" | "editedAt" | "images"
> & {
  deleted: true;
  deletedAt: Date;
};

export const REVIEW_SELECT = {
  id: true,
  version: true,
  authorUserId: true,
  authorAgentId: true,
  body: true,
  createdAt: true,
} as const;

export type ReviewRow = Prisma.ArtifactCommentReviewGetPayload<{ select: typeof REVIEW_SELECT }>;

export type ReviewView = {
  id: string;
  author: ArtifactActorName;
  version: number;
  body: string | null;
  createdAt: Date;
};

type ViewDb = Pick<PrismaClient, "agent" | "user" | "artifactCommentImage">;

type Named = {
  authorUserId: string | null;
  authorAgentId: string | null;
  resolvedByUserId?: string | null;
  resolvedByAgentId?: string | null;
};

const isString = (value: string | null | undefined): value is string => typeof value === "string";

function actorIdsOf(rows: readonly Named[]) {
  return {
    userIds: rows.flatMap((row) => [row.authorUserId, row.resolvedByUserId].filter(isString)),
    agentIds: rows.flatMap((row) => [row.authorAgentId, row.resolvedByAgentId].filter(isString)),
  };
}

type ImagesByComment = ReadonlyMap<string, ArtifactCommentImageView[]>;

async function imagesOf(db: ViewDb, rows: readonly CommentRow[]): Promise<ImagesByComment> {
  const ids = rows.filter((row) => !row.deletedAt).map((row) => row.id);
  const found = ids.length
    ? await db.artifactCommentImage.findMany({
        where: { commentId: { in: ids } },
        orderBy: [{ commentId: "asc" }, { position: "asc" }],
        select: {
          id: true,
          commentId: true,
          contentType: true,
          sizeBytes: true,
          width: true,
          height: true,
        },
      })
    : [];
  const byComment = new Map<string, ArtifactCommentImageView[]>();
  for (const { commentId, ...image } of found)
    byComment.set(commentId, [...(byComment.get(commentId) ?? []), image]);
  return byComment;
}

function commentViewOf(
  names: ReadonlyMap<string, string>,
  images: ImagesByComment,
  row: CommentRow,
): ArtifactCommentView | DeletedCommentView {
  const resolvedBy =
    row.resolvedByUserId || row.resolvedByAgentId
      ? actorOf(names, { userId: row.resolvedByUserId, agentId: row.resolvedByAgentId })
      : null;
  const shared = {
    id: row.id,
    author: actorOf(names, { userId: row.authorUserId, agentId: row.authorAgentId }),
    version: row.version,
    path: row.path,
    replyTo: row.rootId,
    createdAt: row.createdAt,
    reviewId: row.reviewId,
    resolvedAt: row.resolvedAt,
    resolvedBy,
  };
  if (row.deletedAt) return { ...shared, deleted: true as const, deletedAt: row.deletedAt };
  return {
    ...shared,
    anchor: row.anchor,
    body: row.body,
    editedAt: row.editedAt,
    images: images.get(row.id) ?? [],
  };
}

export async function commentViewPairs(
  db: ViewDb,
  workspaceId: string,
  rows: readonly CommentRow[],
): Promise<
  { row: CommentRow; view: ArtifactCommentView | DeletedCommentView; face: string | null }[]
> {
  if (rows.length === 0) return [];
  const [{ names, faces }, images] = await Promise.all([
    actorDirectory(db, workspaceId, actorIdsOf(rows)),
    imagesOf(db, rows),
  ]);
  return rows.map((row) => ({
    row,
    view: commentViewOf(names, images, row),
    face: faces.get(row.authorAgentId ?? row.authorUserId ?? "") ?? null,
  }));
}

export async function commentViews(
  db: ViewDb,
  workspaceId: string,
  rows: readonly CommentRow[],
): Promise<(ArtifactCommentView | DeletedCommentView)[]> {
  if (rows.length === 0) return [];
  const [names, images] = await Promise.all([
    actorNames(db, workspaceId, actorIdsOf(rows)),
    imagesOf(db, rows),
  ]);
  return rows.map((row) => commentViewOf(names, images, row));
}

export async function commentView(db: ViewDb, workspaceId: string, row: CommentRow) {
  return (await commentViews(db, workspaceId, [row]))[0]!;
}

export async function reviewViews(
  db: ViewDb,
  workspaceId: string,
  review: ReviewRow,
  rows: readonly CommentRow[],
): Promise<{ review: ReviewView; comments: (ArtifactCommentView | DeletedCommentView)[] }> {
  const [names, images] = await Promise.all([
    actorNames(db, workspaceId, actorIdsOf([review, ...rows])),
    imagesOf(db, rows),
  ]);
  return {
    review: {
      id: review.id,
      author: actorOf(names, { userId: review.authorUserId, agentId: review.authorAgentId }),
      version: review.version,
      body: review.body,
      createdAt: review.createdAt,
    },
    comments: rows.map((row) => commentViewOf(names, images, row)),
  };
}
