import type { PrismaClient } from "#src/generated/prisma/client";
import type { CommentInput, ReviewInput } from "#src/features/artifacts/artifact-comment-inputs";
import { followByWriting } from "./artifact-follows.server";
import { postComment, postReview } from "./artifact-comments.server";
import type { CommentImageBlobs } from "./artifact-comment-images.server";
import { resolveComment } from "./artifact-comment-threads.server";
import { errorType } from "#src/server/errors/error-type.server";
import { ArtifactNotices, NOBODY_TOLD, type NoticedArtifact } from "./artifact-notices.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";

type Principal = { workspaceId: string; agentId: string };
type Writes = {
  db: PrismaClient;
  blobs: CommentImageBlobs;
  notices?: ArtifactNoticePort | undefined;
};

const noticesOf = (writes: Writes) =>
  writes.notices && new ArtifactNotices(writes.db, writes.notices);

async function bestEffort<T>(event: string, nothing: T, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.warn(JSON.stringify({ event, error_type: errorType(error) }));
    return nothing;
  }
}

function followed(writes: Writes, principal: Principal, artifactId: string) {
  return bestEffort<{ newlyFollowing?: true }>("artifacts:follow_failed", {}, async () => {
    const { newlyFollowing } = await followByWriting(writes.db, {
      artifactId,
      agentId: principal.agentId,
    });
    return newlyFollowing ? { newlyFollowing: true } : {};
  });
}

export async function commentOnArtifact(writes: Writes, principal: Principal, input: CommentInput) {
  const { artifact, comment } = await postComment(writes.db, writes.blobs, principal, input);
  const follow = await followed(writes, principal, artifact.id);
  const told = !("deleted" in comment)
    ? ((await noticesOf(writes)?.comment({
        workspaceId: principal.workspaceId,
        artifact,
        writerId: principal.agentId,
        comment: {
          id: comment.id,
          path: comment.path,
          version: comment.version,
          body: comment.body,
        },
      })) ?? NOBODY_TOLD)
    : NOBODY_TOLD;
  return { ...comment, ...follow, ...told };
}

export async function reviewArtifact(writes: Writes, principal: Principal, input: ReviewInput) {
  const { artifact, review, comments } = await postReview(
    writes.db,
    writes.blobs,
    principal,
    input,
  );
  const follow = await followed(writes, principal, artifact.id);
  const told =
    (await noticesOf(writes)?.review({
      workspaceId: principal.workspaceId,
      artifact,
      writerId: principal.agentId,
      reviewId: review.id,
      review: { version: review.version, body: review.body },
      comments: comments.flatMap((comment) =>
        "deleted" in comment ? [] : [{ path: comment.path, body: comment.body }],
      ),
    })) ?? NOBODY_TOLD;
  return { review, comments, ...follow, ...told };
}

export async function resolveArtifactThread(
  writes: Writes,
  principal: Principal,
  input: { artifact: string; comment: string; note?: string | undefined },
) {
  const resolved = await resolveComment(writes.db, principal, input);
  const { artifact, thread, startedByAgentId, resolvedByAgentId, closingNote, ...answer } =
    resolved;
  const told =
    thread.resolvedAt && resolvedByAgentId === principal.agentId
      ? ((await noticesOf(writes)?.resolve({
          workspaceId: principal.workspaceId,
          artifact,
          writerId: principal.agentId,
          threadId: thread.id,
          threadPath: thread.path,
          resolvedAt: thread.resolvedAt,
          threadAuthorAgentId: startedByAgentId,
          note: closingNote,
        })) ?? NOBODY_TOLD)
      : NOBODY_TOLD;
  return { ...answer, ...told };
}

export async function followedByPush(
  writes: Writes,
  principal: Principal,
  artifactId: string,
  saved: { status: string; number?: number; titleChanged?: { from: string } },
  push: { note?: string | undefined; idempotencyKey: string },
) {
  const renamed = saved.status === "nothing" ? saved.titleChanged : undefined;
  if (saved.status !== "created" && saved.status !== "replayed" && !renamed) return {};
  const follow = renamed ? {} : await followed(writes, principal, artifactId);
  if (!renamed && saved.number === undefined) return follow;
  const artifact = await bestEffort("artifacts:notice_read_failed", null, () =>
    writes.db.artifact.findFirst({
      where: { id: artifactId, workspaceId: principal.workspaceId },
      select: {
        id: true,
        homeKey: true,
        access: true,
        authorAgentId: true,
        name: true,
        title: true,
      },
    }),
  );
  const notices = noticesOf(writes);
  const noticed = (artifact satisfies NoticedArtifact | null) ?? undefined;
  const told =
    noticed &&
    (renamed
      ? await notices?.rename({
          workspaceId: principal.workspaceId,
          artifact: noticed,
          writerId: principal.agentId,
          from: renamed.from,
          to: noticed.title,
          key: push.idempotencyKey,
        })
      : await notices?.version({
          workspaceId: principal.workspaceId,
          artifact: noticed,
          writerId: principal.agentId,
          number: saved.number!,
          note: push.note ?? "",
        }));
  return { ...follow, ...(told ?? NOBODY_TOLD) };
}

export async function followedByCreate(
  writes: Writes,
  principal: Principal,
  created: { id: string },
) {
  return followed(writes, principal, created.id);
}
