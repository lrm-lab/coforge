import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  canResolveArtifactComment,
  requireReadableArtifact,
} from "./artifact-comment-access.server";
import { COMMENT_SELECT, commentViews } from "./artifact-comment-view.server";
import {
  CLEARED_RESOLUTION,
  currentVersionOf,
  insertComments,
  nextStamp,
  reopenThreads,
  withCommentLock,
  type CommentTx,
} from "./artifact-comment-write.server";

type Principal = { workspaceId: string; agentId: string };

/** The thread's root, refused for a reply and for an actor who may not close or open threads. An
 * Agent does so as the thread's author or the artifact's: it is never a Workspace owner or admin
 * (a person may be, `canResolveArtifactComment`). */
async function threadRoot(
  tx: CommentTx,
  principal: Principal,
  artifact: { id: string; authorUserId: string | null; authorAgentId: string | null },
  commentId: string,
) {
  const root = await tx.artifactComment.findFirst({
    where: { id: commentId, artifactId: artifact.id },
    select: { ...COMMENT_SELECT },
  });
  if (!root)
    throw new AppError("NOT_FOUND", {
      errorId: "artifact-comment-not-found",
      hint: `this artifact has no comment ${commentId}`,
    });
  if (root.rootId)
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-comment-reply",
      hint: `${commentId} is a reply: a thread is resolved or reopened by its first comment, ${root.rootId}`,
    });
  const allowed = await canResolveArtifactComment(
    tx,
    principal.workspaceId,
    { agentId: principal.agentId },
    { artifact, root },
  );
  if (!allowed)
    throw new AppError("ACCESS_DENIED", {
      errorId: "artifact-comment-thread",
      hint: "only the thread's author or the artifact's author resolves or reopens a thread",
    });
  return root;
}

/**
 * Resolves a thread by its root. Allowed for the thread's author and the artifact's author (a
 * person also as the owner of the Agent that made it, or a Workspace owner or admin). A thread
 * already resolved is left as it is: `changed: false`, and a note is not posted. A `note` is posted
 * first, as a reply that does not reopen the thread it closes.
 */
export async function resolveComment(
  db: PrismaClient,
  principal: Principal,
  input: { artifact: string; comment: string; note?: string | undefined },
) {
  const { workspaceId, agentId } = principal;
  const artifact = await requireReadableArtifact(db, workspaceId, { agentId }, input.artifact);
  const done = await withCommentLock(db, artifact.id, async (tx) => {
    const root = await threadRoot(tx, principal, artifact, input.comment);
    if (root.resolvedAt) return { row: root, changed: false, note: undefined };
    const stamp = await nextStamp(tx, artifact.id);
    const [note] = input.note
      ? await insertComments(tx, {
          artifactId: artifact.id,
          agentId,
          prepared: [
            {
              body: input.note,
              path: root.path,
              anchor: null,
              rootId: root.id,
              version: await currentVersionOf(tx, artifact.id),
            },
          ],
          stamp,
        })
      : [];
    const row = await tx.artifactComment.update({
      where: { id: root.id },
      data: { resolvedAt: stamp, resolvedByAgentId: agentId, resolvedByUserId: null },
      select: COMMENT_SELECT,
    });
    return { row, changed: true, note };
  });
  const [comment, note] = await commentViews(
    db,
    workspaceId,
    done.note ? [done.row, done.note] : [done.row],
  );
  return { comment: comment!, changed: done.changed, ...(note ? { note } : {}) };
}

/** Reopens a resolved thread by its root, for the same people who may resolve it. A thread that
 * is open is left as it is: `changed: false`. */
export async function reopenComment(
  db: PrismaClient,
  principal: Principal,
  input: { artifact: string; comment: string },
) {
  const { workspaceId, agentId } = principal;
  const artifact = await requireReadableArtifact(db, workspaceId, { agentId }, input.artifact);
  const done = await withCommentLock(db, artifact.id, async (tx) => {
    const root = await threadRoot(tx, principal, artifact, input.comment);
    if (!root.resolvedAt) return { row: root, changed: false };
    await reopenThreads(tx, [root.id]);
    return { row: { ...root, ...CLEARED_RESOLUTION }, changed: true };
  });
  const [comment] = await commentViews(db, workspaceId, [done.row]);
  return { comment: comment!, changed: done.changed };
}
