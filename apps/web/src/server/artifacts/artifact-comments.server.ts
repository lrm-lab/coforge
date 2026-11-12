import type { PrismaClient } from "#src/generated/prisma/client";
import type { CommentInput, ReviewInput } from "#src/features/artifacts/artifact-comment-inputs";
import { payloadHash } from "#src/server/canonical-hash.server";
import { requireReadableArtifact } from "./artifact-comment-access.server";
import { requireNoUnseenComments, type CommentScope } from "./artifact-comment-gate.server";
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
  type PreparedComment,
} from "./artifact-comment-write.server";
import { idempotencyMismatch } from "./artifact-idempotency.server";

type Principal = { workspaceId: string; agentId: string };

const scopeOf = (prepared: PreparedComment): CommentScope => ({
  paths: prepared.path === null ? [] : [prepared.path],
  threadIds: prepared.rootId === null ? [] : [prepared.rootId],
});

/**
 * An Agent's comment. Whoever can read the artifact may comment (the access predicates of a read:
 * the home's readers, or every member of the Workspace for a Workspace-tier artifact); the home's
 * write access is not needed. The comment is refused while others commented on its file, its
 * thread or the whole artifact since the Agent last read comments (`artifact-unseen-comments`),
 * unless the same key already landed, which replays it. A reply to a resolved thread reopens it.
 */
export async function postComment(db: PrismaClient, principal: Principal, input: CommentInput) {
  const { workspaceId, agentId } = principal;
  const artifact = await requireReadableArtifact(db, workspaceId, { agentId }, input.artifact);
  const { artifact: _artifact, idempotencyKey, ...draft } = input;
  const requestHash = payloadHash({ operation: "comment", ...draft });
  const row = await withCommentLock(db, artifact.id, async (tx) => {
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
    await requireNoUnseenComments(tx, {
      artifactId: artifact.id,
      agentId,
      scopes: [scopeOf(prepared!)],
    });
    const [inserted] = await insertComments(tx, {
      artifactId: artifact.id,
      agentId,
      prepared: [prepared!],
      stamp: await nextStamp(tx, artifact.id),
      idempotencyKey,
      requestHash,
    });
    if (prepared!.rootId) await reopenThreads(tx, [prepared!.rootId]);
    return inserted!;
  });
  return commentView(db, workspaceId, row);
}

/**
 * An Agent's review: one summary over one to fifty comments that land together or not at all. A
 * refusal of any comment names its index and writes nothing. The gate looks at all the comments'
 * files and threads at once and, when it refuses, names the first comment it is about; the same
 * key and the same review replay the one already written.
 */
export async function postReview(db: PrismaClient, principal: Principal, input: ReviewInput) {
  const { workspaceId, agentId } = principal;
  const artifact = await requireReadableArtifact(db, workspaceId, { agentId }, input.artifact);
  const { artifact: _artifact, idempotencyKey, ...content } = input;
  const requestHash = payloadHash({ operation: "review", ...content });
  const written = await withCommentLock(db, artifact.id, async (tx) => {
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
    await requireNoUnseenComments(tx, {
      artifactId: artifact.id,
      agentId,
      scopes: prepared.map(scopeOf),
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
    const roots = new Set(prepared.flatMap((entry) => entry.rootId ?? []));
    if (roots.size) await reopenThreads(tx, [...roots]);
    return { review, rows };
  });
  return reviewViews(db, workspaceId, written.review, written.rows);
}
