import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { actorNames, actorOf, type ArtifactActorName } from "./artifact-actor-names.server";

/** The columns of a comment a reader is shown. */
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

/** A comment as a reader sees it. `replyTo` is the thread's root (null on a root); `resolvedAt`
 * and `resolvedBy` are set only on a resolved root. */
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
  resolvedAt: Date | null;
  resolvedBy: ArtifactActorName | null;
};

/** A deleted comment: where it was and who wrote it, never what it said. */
export type DeletedCommentView = Omit<ArtifactCommentView, "body" | "anchor" | "editedAt"> & {
  deleted: true;
  deletedAt: Date;
};

/** The columns of a review a reader is shown. */
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

type ViewDb = Pick<PrismaClient, "agent" | "user">;

type Named = {
  authorUserId: string | null;
  authorAgentId: string | null;
  resolvedByUserId?: string | null;
  resolvedByAgentId?: string | null;
};

const isString = (value: string | null | undefined): value is string => typeof value === "string";

/** Every name the rows show, in one lookup. */
async function namesOf(db: ViewDb, workspaceId: string, rows: readonly Named[]) {
  return actorNames(db, workspaceId, {
    userIds: rows.flatMap((row) => [row.authorUserId, row.resolvedByUserId].filter(isString)),
    agentIds: rows.flatMap((row) => [row.authorAgentId, row.resolvedByAgentId].filter(isString)),
  });
}

function commentViewOf(
  names: ReadonlyMap<string, string>,
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
  return { ...shared, anchor: row.anchor, body: row.body, editedAt: row.editedAt };
}

/** The comments as readers see them, in the order given. */
export async function commentViews(
  db: ViewDb,
  workspaceId: string,
  rows: readonly CommentRow[],
): Promise<(ArtifactCommentView | DeletedCommentView)[]> {
  if (rows.length === 0) return [];
  const names = await namesOf(db, workspaceId, rows);
  return rows.map((row) => commentViewOf(names, row));
}

/** One comment as readers see it. */
export async function commentView(db: ViewDb, workspaceId: string, row: CommentRow) {
  return (await commentViews(db, workspaceId, [row]))[0]!;
}

/** A review and its comments as readers see them: every name in one lookup. */
export async function reviewViews(
  db: ViewDb,
  workspaceId: string,
  review: ReviewRow,
  rows: readonly CommentRow[],
): Promise<{ review: ReviewView; comments: (ArtifactCommentView | DeletedCommentView)[] }> {
  const names = await namesOf(db, workspaceId, [review, ...rows]);
  return {
    review: {
      id: review.id,
      author: actorOf(names, { userId: review.authorUserId, agentId: review.authorAgentId }),
      version: review.version,
      body: review.body,
      createdAt: review.createdAt,
    },
    comments: rows.map((row) => commentViewOf(names, row)),
  };
}
