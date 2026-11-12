import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { COMMENT_PAGE_SIZE } from "#src/features/artifacts/artifact-comment-inputs";
import { AppError } from "#src/lib/app-error";
import type { ArtifactActorName } from "./artifact-actor-names.server";
import { requireReadableArtifact } from "./artifact-comment-access.server";
import {
  COMMENT_ORDER,
  advanceCommentPosition,
  afterCursor,
  commentPositionOf,
  cursorOf,
  formatCursor,
  laterCursor,
  parseCursor,
  unseenWhere,
} from "./artifact-comment-unseen.server";
import {
  COMMENT_SELECT,
  REVIEW_SELECT,
  commentViews,
  reviewViews,
} from "./artifact-comment-view.server";
import { countUnseenVersions } from "./artifact-read-positions.server";

/** How many unseen comments a read of the artifact excerpts (the newest); the count is of all. */
const UNSEEN_COMMENTS_SHOWN = 5;
const EXCERPT_CHARS = 200;

type Principal = { workspaceId: string; agentId: string };

/** One unseen comment as a read of the artifact shows it. */
export type UnseenCommentExcerpt = {
  id: string;
  author: ArtifactActorName;
  path: string | null;
  createdAt: Date;
  excerpt: string;
};

/**
 * A page of an artifact's comments, oldest first, 50 at most.
 *
 * - By default (`unseen`) the comments of others after the Agent's comment position. Reading the
 *   whole unseen list, with no `path` and no `review`, moves the position over the page returned,
 *   never backwards. A filtered read moves nothing: one position cannot say "read these but not
 *   the older ones before them". Nor does a page that starts at an `after` cursor beyond the
 *   position, for the same reason.
 * - `all` lists every comment, the Agent's own and deleted ones (without text) included, and
 *   moves nothing.
 * - `path` narrows either to one file: its root comments and their replies.
 * - `review` lists that review's comments, with its summary, as `all` does.
 * - `after` is the `nextCursor` of the page before.
 *
 * `unseenVersionCount` is how many versions of others came since the Agent's version position.
 */
export async function listComments(
  db: PrismaClient,
  principal: Principal,
  input: { artifact: string; path?: string; all?: boolean; review?: string; after?: string },
) {
  const { workspaceId, agentId } = principal;
  const artifact = await requireReadableArtifact(db, workspaceId, { agentId }, input.artifact);
  const cursor = input.after === undefined ? null : (parseCursor(input.after) ?? null);
  if (input.after !== undefined && !cursor)
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-cursor",
      hint: "after takes the cursor the previous page named",
    });
  const view = input.all || input.review ? "all" : "unseen";
  const [review, position] = await Promise.all([
    input.review
      ? db.artifactCommentReview.findFirst({
          where: { id: input.review, artifactId: artifact.id },
          select: REVIEW_SELECT,
        })
      : null,
    view === "unseen" ? commentPositionOf(db, { artifactId: artifact.id, agentId }) : null,
  ]);
  if (input.review && !review)
    throw new AppError("NOT_FOUND", {
      errorId: "artifact-review-not-found",
      hint: `this artifact has no review ${input.review}`,
    });
  const path: Prisma.ArtifactCommentWhereInput = input.path
    ? { OR: [{ path: input.path }, { root: { is: { path: input.path } } }] }
    : {};
  const base: Prisma.ArtifactCommentWhereInput =
    view === "unseen"
      ? unseenWhere({ artifactId: artifact.id, agentId, position: laterCursor(position, cursor) })
      : {
          artifactId: artifact.id,
          ...(review ? { reviewId: review.id } : {}),
          ...afterCursor(cursor),
        };
  const rows = await db.artifactComment.findMany({
    where: { AND: [base, path] },
    orderBy: [...COMMENT_ORDER],
    take: COMMENT_PAGE_SIZE + 1,
    select: COMMENT_SELECT,
  });
  const page = rows.slice(0, COMMENT_PAGE_SIZE);
  const last = page.at(-1);
  // A cursor beyond the position skips the unseen comments between them: those are not read.
  const skipsAhead = cursor !== null && laterCursor(position, cursor) === cursor;
  const moves = view === "unseen" && !input.path && !skipsAhead && last;
  const [shown, unseenVersionCount] = await Promise.all([
    review
      ? reviewViews(db, workspaceId, review, page)
      : { comments: await commentViews(db, workspaceId, page) },
    countUnseenVersions(db, {
      artifactId: artifact.id,
      agentId,
      current: artifact.currentVersion,
    }),
    moves
      ? advanceCommentPosition(db, { artifactId: artifact.id, agentId, commentId: last.id })
      : undefined,
  ]);
  return {
    view,
    ...("review" in shown ? { review: shown.review } : {}),
    comments: shown.comments,
    ...(rows.length > page.length && last ? { nextCursor: formatCursor(cursorOf(last)) } : {}),
    unseenVersionCount,
  };
}

/**
 * What a read of the artifact says of the comments an Agent has not read: how many, and the
 * newest few as excerpts. It computes from the comment position and moves nothing: only
 * `comments` does.
 */
export async function unseenCommentSummary(
  db: PrismaClient,
  input: { workspaceId: string; artifactId: string; agentId: string },
) {
  const where = unseenWhere({
    artifactId: input.artifactId,
    agentId: input.agentId,
    position: await commentPositionOf(db, input),
  });
  const rows = await db.artifactComment.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: UNSEEN_COMMENTS_SHOWN,
    select: COMMENT_SELECT,
  });
  const count =
    rows.length < UNSEEN_COMMENTS_SHOWN ? rows.length : await db.artifactComment.count({ where });
  const comments: UnseenCommentExcerpt[] = (
    await commentViews(db, input.workspaceId, rows)
  ).flatMap((view) =>
    "body" in view
      ? [
          {
            id: view.id,
            author: view.author,
            path: view.path,
            createdAt: view.createdAt,
            excerpt: view.body.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS),
          },
        ]
      : [],
  );
  return { count, comments };
}
