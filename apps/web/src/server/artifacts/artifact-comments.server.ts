import type { PrismaClient } from "#src/generated/prisma/client";
import type { CommentInput, ReviewInput } from "#src/features/artifacts/artifact-comment-inputs";
import { payloadHash } from "#src/server/canonical-hash.server";
import { requireReadableArtifact } from "./artifact-comment-access.server";
import {
  commentScope,
  recordingRefusal,
  requireNoUnseenChanges,
} from "./artifact-comment-gate.server";
import {
  attachImages,
  prepareImages,
  type CommentImageBlobs,
  type PreparedImage,
} from "./artifact-comment-images.server";
import { COMMENT_ORDER } from "./artifact-comment-unseen.server";
import {
  COMMENT_SELECT,
  REVIEW_SELECT,
  commentView,
  reviewViews,
} from "./artifact-comment-view.server";
import {
  insertComments,
  nextStamp,
  prepareComments,
  reopenThreads,
  withCommentLock,
} from "./artifact-comment-write.server";
import { idempotencyMismatch } from "./artifact-idempotency.server";

type Principal = { workspaceId: string; agentId: string };

export async function postComment(
  db: PrismaClient,
  blobs: CommentImageBlobs,
  principal: Principal,
  input: CommentInput,
) {
  const { workspaceId, agentId } = principal;
  const artifact = await requireReadableArtifact(db, workspaceId, { agentId }, input.artifact);
  const { artifact: _artifact, idempotencyKey, ...draft } = input;
  const requestHash = payloadHash({ operation: "comment", ...draft });
  const earlier = await db.artifactComment.findFirst({
    where: { artifactId: artifact.id, authorAgentId: agentId, idempotencyKey },
    select: { requestHash: true },
  });
  if (earlier && earlier.requestHash !== requestHash) throw idempotencyMismatch();
  const images = earlier ? [] : await prepareImages(blobs, principal, draft.images ?? []);
  const row = await recordingRefusal(db, { artifactId: artifact.id, agentId }, () =>
    withCommentLock(db, artifact.id, async (tx) => {
      const replay = await tx.artifactComment.findFirst({
        where: { artifactId: artifact.id, authorAgentId: agentId, idempotencyKey },
        select: { ...COMMENT_SELECT, requestHash: true },
      });
      if (replay) {
        if (replay.requestHash !== requestHash) throw idempotencyMismatch();
        return replay;
      }
      const [prepared] = await prepareComments(tx, artifact.id, [draft], {
        version: input.version,
      });
      await requireNoUnseenChanges(tx, {
        workspaceId,
        artifactId: artifact.id,
        agentId,
        action: "comment",
        scopes: [commentScope(prepared!)],
      });
      const [inserted] = await insertComments(tx, {
        artifactId: artifact.id,
        agentId,
        prepared: [prepared!],
        stamp: await nextStamp(tx, artifact.id),
        idempotencyKey,
        requestHash,
      });
      await attachImages(tx, blobs, {
        workspaceId,
        artifactId: artifact.id,
        rows: [inserted!],
        images: [images],
      });
      if (prepared!.rootId) await reopenThreads(tx, [prepared!.rootId]);
      return inserted!;
    }),
  );
  return { artifact, comment: await commentView(db, workspaceId, row) };
}

export async function postReview(
  db: PrismaClient,
  blobs: CommentImageBlobs,
  principal: Principal,
  input: ReviewInput,
) {
  const { workspaceId, agentId } = principal;
  const artifact = await requireReadableArtifact(db, workspaceId, { agentId }, input.artifact);
  const { artifact: _artifact, idempotencyKey, ...content } = input;
  const requestHash = payloadHash({ operation: "review", ...content });
  const earlier = await db.artifactCommentReview.findFirst({
    where: { artifactId: artifact.id, authorAgentId: agentId, idempotencyKey },
    select: { requestHash: true },
  });
  if (earlier && earlier.requestHash !== requestHash) throw idempotencyMismatch();
  const images: PreparedImage[][] = [];
  if (!earlier)
    for (const comment of input.comments)
      images.push(await prepareImages(blobs, principal, comment.images ?? []));
  const written = await recordingRefusal(db, { artifactId: artifact.id, agentId }, () =>
    withCommentLock(db, artifact.id, async (tx) => {
      const replay = await tx.artifactCommentReview.findFirst({
        where: { artifactId: artifact.id, authorAgentId: agentId, idempotencyKey },
        select: { ...REVIEW_SELECT, requestHash: true },
      });
      if (replay) {
        if (replay.requestHash !== requestHash) throw idempotencyMismatch();
        const rows = await tx.artifactComment.findMany({
          where: { reviewId: replay.id },
          orderBy: [...COMMENT_ORDER],
          select: COMMENT_SELECT,
        });
        return { review: replay, rows };
      }
      const prepared = await prepareComments(tx, artifact.id, input.comments, {
        version: input.version,
        indexed: true,
      });
      await requireNoUnseenChanges(tx, {
        workspaceId,
        artifactId: artifact.id,
        agentId,
        action: "review",
        scopes: prepared.map(commentScope),
        indexed: true,
      });
      const stamp = await nextStamp(tx, artifact.id);
      const review = await tx.artifactCommentReview.create({
        data: {
          artifactId: artifact.id,
          version: prepared[0]!.version,
          authorAgentId: agentId,
          ...(input.body === undefined ? {} : { body: input.body }),
          idempotencyKey,
          requestHash,
          createdAt: stamp,
        },
        select: REVIEW_SELECT,
      });
      const rows = await insertComments(tx, {
        artifactId: artifact.id,
        agentId,
        prepared,
        stamp,
        reviewId: review.id,
      });
      await attachImages(tx, blobs, { workspaceId, artifactId: artifact.id, rows, images });
      const roots = new Set(prepared.flatMap((entry) => entry.rootId ?? []));
      if (roots.size) await reopenThreads(tx, [...roots]);
      return { review, rows };
    }),
  );
  return {
    artifact,
    ...(await reviewViews(db, workspaceId, written.review, written.rows)),
  };
}
