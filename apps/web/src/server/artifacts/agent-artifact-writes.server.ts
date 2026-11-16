import type { PrismaClient } from "#src/generated/prisma/client";
import type { CommentInput, ReviewInput } from "#src/features/artifacts/artifact-comment-inputs";
import { followByWriting } from "./artifact-follows.server";
import { postComment, postReview } from "./artifact-comments.server";
import { resolveComment } from "./artifact-comment-threads.server";
import { ArtifactNotices, NOBODY_TOLD, type NoticedArtifact } from "./artifact-notices.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";

type Principal = { workspaceId: string; agentId: string };
type Writes = { db: PrismaClient; notices?: ArtifactNoticePort | undefined };

const noticesOf = (writes: Writes) =>
  writes.notices && new ArtifactNotices(writes.db, writes.notices);

async function followed(writes: Writes, principal: Principal, artifactId: string) {
  const { newlyFollowing } = await followByWriting(writes.db, {
    artifactId,
    agentId: principal.agentId,
  });
  return newlyFollowing ? { newlyFollowing: true as const } : {};
}

export async function commentOnArtifact(writes: Writes, principal: Principal, input: CommentInput) {
  const { artifact, fresh, comment } = await postComment(writes.db, principal, input);
  const follow = await followed(writes, principal, artifact.id);
  const told =
    fresh && !("deleted" in comment)
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
  const { artifact, fresh, review, comments } = await postReview(writes.db, principal, input);
  const follow = await followed(writes, principal, artifact.id);
  const told = fresh
    ? ((await noticesOf(writes)?.review({
        workspaceId: principal.workspaceId,
        artifact,
        writerId: principal.agentId,
        reviewId: review.id,
        review: { version: review.version, body: review.body },
        comments: comments.flatMap((comment) =>
          "deleted" in comment ? [] : [{ path: comment.path, body: comment.body }],
        ),
      })) ?? NOBODY_TOLD)
    : NOBODY_TOLD;
  return { review, comments, ...follow, ...told };
}

export async function resolveArtifactThread(
  writes: Writes,
  principal: Principal,
  input: { artifact: string; comment: string; note?: string | undefined },
) {
  const resolved = await resolveComment(writes.db, principal, input);
  const { artifact, thread, startedByAgentId, ...answer } = resolved;
  const told =
    resolved.changed && thread.resolvedAt
      ? ((await noticesOf(writes)?.resolve({
          workspaceId: principal.workspaceId,
          artifact,
          writerId: principal.agentId,
          threadId: thread.id,
          threadPath: thread.path,
          resolvedAt: thread.resolvedAt,
          threadAuthorAgentId: startedByAgentId,
          note: input.note,
        })) ?? NOBODY_TOLD)
      : NOBODY_TOLD;
  return { ...answer, ...told };
}

export async function followedByPush(
  writes: Writes,
  principal: Principal,
  artifactId: string,
  saved: { status: string; number?: number },
  note: string | undefined,
) {
  if (saved.status !== "created" && saved.status !== "replayed") return {};
  const follow = await followed(writes, principal, artifactId);
  if (saved.status === "replayed" || saved.number === undefined) return follow;
  const artifact = await writes.db.artifact.findFirst({
    where: { id: artifactId, workspaceId: principal.workspaceId },
    select: { id: true, homeKey: true, access: true, authorAgentId: true, name: true, title: true },
  });
  const told =
    artifact &&
    ((await noticesOf(writes)?.version({
      workspaceId: principal.workspaceId,
      artifact: artifact satisfies NoticedArtifact,
      writerId: principal.agentId,
      number: saved.number,
      note: note ?? "",
    })) ??
      NOBODY_TOLD);
  return { ...follow, ...(told ?? NOBODY_TOLD) };
}

export async function followedByCreate(
  writes: Writes,
  principal: Principal,
  created: { id: string },
) {
  return followed(writes, principal, created.id);
}
