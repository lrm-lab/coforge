import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  canResolveArtifactComment,
  requireReadableArtifact,
} from "./artifact-comment-access.server";
import { commentScope } from "./artifact-comment-gate.server";
import { commentColumns } from "./artifact-actor-columns.server";
import { actorOf, unseenGate, type CommentPrincipal } from "./artifact-comment-principal.server";
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

async function threadRoot(
  tx: CommentTx,
  principal: CommentPrincipal,
  artifact: { id: string; authorAgentId: string | null },
  commentId: string,
) {
  const { workspaceId } = principal;
  const actor = actorOf(principal);
  const root = await tx.artifactComment.findFirst({
    where: { id: commentId, artifactId: artifact.id, deletedAt: null },
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
  const allowed = await canResolveArtifactComment(tx, workspaceId, actor, { artifact, root });
  if (!allowed)
    throw new AppError("ACCESS_DENIED", {
      errorId: "artifact-comment-thread",
      hint: "only the thread's author or the artifact's author resolves or reopens a thread",
    });
  return root;
}

export async function resolveComment(
  db: PrismaClient,
  principal: CommentPrincipal,
  input: { artifact: string; comment: string; note?: string | undefined },
) {
  const { workspaceId } = principal;
  const actor = actorOf(principal);
  const columns = commentColumns(actor);
  const gate = unseenGate(principal);
  const artifact = await requireReadableArtifact(db, workspaceId, actor, input.artifact);
  const done = await gate.recording(db, artifact.id, () =>
    withCommentLock(db, artifact.id, async (tx) => {
      const root = await threadRoot(tx, principal, artifact, input.comment);
      if (root.resolvedAt) {
        const closing = await tx.artifactComment.findFirst({
          where: {
            artifactId: artifact.id,
            rootId: root.id,
            ...columns.author,
            createdAt: root.resolvedAt,
          },
          select: { body: true },
        });
        return {
          row: root,
          changed: false,
          note: undefined,
          startedBy: root.authorAgentId,
          closingNote: closing?.body,
        };
      }
      await gate.require(tx, {
        artifactId: artifact.id,
        action: "resolve",
        scopes: [commentScope({ path: root.path, rootId: root.id })],
      });
      const stamp = await nextStamp(tx, artifact.id);
      const [note] = input.note
        ? await insertComments(tx, {
            artifactId: artifact.id,
            author: actor,
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
        data: { resolvedAt: stamp, ...columns.resolver },
        select: COMMENT_SELECT,
      });
      return { row, changed: true, note, startedBy: root.authorAgentId, closingNote: input.note };
    }),
  );
  const [comment, note] = await commentViews(
    db,
    workspaceId,
    done.note ? [done.row, done.note] : [done.row],
  );
  return {
    artifact,
    thread: { id: done.row.id, path: done.row.path, resolvedAt: done.row.resolvedAt },
    startedByAgentId: done.startedBy,
    resolvedByAgentId: done.row.resolvedByAgentId,
    closingNote: done.closingNote,
    comment: comment!,
    changed: done.changed,
    ...(note ? { note } : {}),
  };
}

export async function reopenComment(
  db: PrismaClient,
  principal: CommentPrincipal,
  input: { artifact: string; comment: string },
) {
  const { workspaceId } = principal;
  const artifact = await requireReadableArtifact(
    db,
    workspaceId,
    actorOf(principal),
    input.artifact,
  );
  const done = await withCommentLock(db, artifact.id, async (tx) => {
    const root = await threadRoot(tx, principal, artifact, input.comment);
    if (!root.resolvedAt) return { row: root, changed: false };
    await reopenThreads(tx, [root.id]);
    return { row: { ...root, ...CLEARED_RESOLUTION }, changed: true };
  });
  const [comment] = await commentViews(db, workspaceId, [done.row]);
  return { artifact, comment: comment!, changed: done.changed };
}

type Resolved = Awaited<ReturnType<typeof resolveComment>>;

export function resolvedNotice(
  workspaceId: string,
  resolved: Resolved,
  writer: { writerId: string } | { writerName: string },
) {
  const { artifact, thread } = resolved;
  if (!thread.resolvedAt) return null;
  return {
    workspaceId,
    artifact,
    ...writer,
    threadId: thread.id,
    threadPath: thread.path,
    resolvedAt: thread.resolvedAt,
    threadAuthorAgentId: resolved.startedByAgentId,
    note: resolved.closingNote,
  };
}
