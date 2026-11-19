import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { COMMENT_PAGE_SIZE } from "#src/features/artifacts/artifact-comment-inputs";
import { AppError } from "#src/lib/app-error";
import type { ArtifactActor } from "./artifact-access.server";
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
import { unseenCommentBlock } from "./artifact-unseen-block.server";

type Principal = { workspaceId: string; agentId: string };

export async function listComments(
  db: PrismaClient,
  principal: Principal,
  input: { artifact: string; path?: string; all?: boolean; review?: string; after?: string },
  readActor?: ArtifactActor,
) {
  const { workspaceId, agentId } = principal;
  const artifact = await requireReadableArtifact(
    db,
    workspaceId,
    readActor ?? { agentId },
    input.artifact,
  );
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

export async function readUnseenComments(
  db: PrismaClient,
  input: { workspaceId: string; artifactId: string; agentId: string },
) {
  const { count, comments, excerpts, unread, seenThrough } = await unseenCommentBlock(db, input);
  if (seenThrough)
    await advanceCommentPosition(db, {
      artifactId: input.artifactId,
      agentId: input.agentId,
      commentId: seenThrough,
    });
  return { count, comments, excerpts, unread };
}
