import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES, COMMENT_BODY_MAX } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  COMMENT_HANDLES_RESOLVED_MAX,
  COMMENT_MENTIONS_MAX,
  type CommentInput,
} from "#src/features/artifacts/artifact-comment-inputs";
import { AppError } from "#src/lib/app-error";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { ARTIFACT_UNREFERENCED_QUOTA_BYTES } from "./agent-artifact-files.server";
import { requireReadableArtifact } from "./artifact-comment-access.server";
import {
  readCommentImageBytes,
  storeCleanImage,
  type CommentImageBlobs,
} from "./artifact-comment-images.server";
import { mentionCandidates } from "./artifact-comment-mentions.server";
import { personPrincipal } from "./artifact-comment-principal.server";
import { commentsById, listThreads, reviewComments } from "./artifact-comment-thread-reads.server";
import { reopenComment, resolveComment, resolvedNotice } from "./artifact-comment-threads.server";
import { postComment } from "./artifact-comments.server";
import { deleteOwnComment, editOwnComment, withCommentLock } from "./artifact-comment-write.server";
import { artifactRateLimited } from "./artifact-rate-limited-response.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";
import {
  ArtifactNotices,
  NOBODY_TOLD,
  commentAudience,
  requireMentionable,
} from "./artifact-notices.server";
import { settleWrite } from "./artifact-activity-wake.server";
import {
  peopleMentionedIn,
  removeMentions,
  rewriteMentions,
} from "./artifact-comment-mention-rows.server";
import { announceArtifactComments, type ArtifactSignals } from "./artifact-signals.server";
import { ArtifactStorageFull, type StoredArtifactBlobs } from "./artifact-blobs.server";

type Place = { workspaceId: string; artifactId: string; userId: string };

type Blobs = CommentImageBlobs & Pick<StoredArtifactBlobs, "upload" | "release">;

export type CommentDraftInput = Omit<CommentInput, "artifact" | "version">;

export class ArtifactPersonComments {
  constructor(
    private readonly db: PrismaClient,
    private readonly blobs: Blobs,
    private readonly port: ArtifactNoticePort,
    private readonly signals?: ArtifactSignals,
    private readonly limit?: AppRateLimit,
  ) {}

  async list(input: Place & { before?: string | undefined }) {
    const artifact = await this.readable(input);
    return listThreads(this.db, { ...input, artifact });
  }

  async byId(input: Place & { ids: readonly string[] }) {
    const artifact = await this.readable(input);
    return commentsById(this.db, { ...input, artifact });
  }

  async review(input: Place & { reviewId: string }) {
    const artifact = await this.readable(input);
    return reviewComments(this.db, { ...input, artifact });
  }

  async candidates(input: Place) {
    const artifact = await this.readable(input);
    return {
      ...(await mentionCandidates(this.db, input.workspaceId, artifact)),
      viewerId: input.userId,
    };
  }

  async willNotify(input: Place & { body: string }) {
    await this.admit(input.userId);
    if (input.body.length > COMMENT_BODY_MAX)
      throw new AppError("INVALID_INPUT", { errorId: "artifact-comment-body" });
    const artifact = await this.readable(input);
    const { told, mentions } = await this.notices().recipients(
      { workspaceId: input.workspaceId, artifact },
      commentAudience(input.body, COMMENT_HANDLES_RESOLVED_MAX),
    );
    return {
      notified: told.map(({ label }) => label),
      cannotSee: mentions.cannotSee,
      tooMany: mentions.count > COMMENT_MENTIONS_MAX,
    };
  }

  async post(input: Place & { comment: CommentDraftInput; version?: number | undefined }) {
    await this.admit(input.userId);
    const artifact = await this.readable(input);
    const notices = this.notices();
    const audience = await notices.recipients(
      { workspaceId: input.workspaceId, artifact },
      commentAudience(input.comment.body, COMMENT_HANDLES_RESOLVED_MAX),
    );
    requireMentionable(audience.mentions);
    const written = await postComment(
      this.db,
      this.blobs,
      personPrincipal(input),
      { ...input.comment, artifact: artifact.id, version: input.version },
      artifact,
    );
    const { comment } = written;
    await announceArtifactComments(this.signals, input.workspaceId, artifact, {
      change: "posted",
      commentIds: [comment.id],
    });
    settleWrite(this.db, this.signals, written.after);
    const told =
      "deleted" in comment
        ? NOBODY_TOLD
        : await notices.comment(
            {
              workspaceId: input.workspaceId,
              artifact,
              writerName: comment.author.name,
              comment: {
                id: comment.id,
                path: comment.path,
                version: comment.version,
                body: comment.body,
              },
            },
            audience,
          );
    return { id: comment.id, ...told };
  }

  async edit(input: Place & { commentId: string; body: string }) {
    const artifact = await this.readable(input);
    const { mentions } = await this.notices().recipients(
      { workspaceId: input.workspaceId, artifact },
      commentAudience(input.body, COMMENT_HANDLES_RESOLVED_MAX),
    );
    requireMentionable(mentions);
    const [people] = await peopleMentionedIn(this.db, input.workspaceId, [input.body]);
    const place = { workspaceId: input.workspaceId, artifact };
    const changed = await withCommentLock(this.db, artifact.id, async (tx) => {
      const edited = await editOwnComment(tx, { ...input, artifactId: artifact.id });
      if (!edited) return undefined;
      const { followed, removed } = await rewriteMentions(tx, place, {
        commentId: input.commentId,
        people: people ?? [],
        editedAt: edited.editedAt,
        authorUserId: input.userId,
      });
      return { ...place, writerUserId: input.userId, alsoUserIds: [...followed, ...removed] };
    });
    await announceArtifactComments(this.signals, input.workspaceId, artifact, {
      change: "edited",
      commentIds: [input.commentId],
    });
    settleWrite(this.db, this.signals, changed);
    return { id: input.commentId };
  }

  async remove(input: Place & { commentId: string }) {
    const artifact = await this.readable(input);
    const told = await withCommentLock(this.db, artifact.id, async (tx) => {
      const released = await deleteOwnComment(tx, { ...input, artifactId: artifact.id });
      await this.blobs.release(tx, input.workspaceId, released);
      return removeMentions(tx, input.commentId);
    });
    await announceArtifactComments(this.signals, input.workspaceId, artifact, {
      change: "deleted",
      commentIds: [input.commentId],
    });
    settleWrite(this.db, this.signals, {
      workspaceId: input.workspaceId,
      artifact,
      writerUserId: input.userId,
      alsoUserIds: told,
    });
    return { id: input.commentId };
  }

  async resolve(input: Place & { commentId: string }) {
    const resolved = await resolveComment(this.db, personPrincipal(input), {
      artifact: input.artifactId,
      comment: input.commentId,
    });
    if (!resolved.changed) return { changed: false as const };
    await announceArtifactComments(this.signals, input.workspaceId, resolved.artifact, {
      change: "resolved",
      commentIds: [resolved.thread.id],
    });
    const notice = resolvedNotice(input.workspaceId, resolved, {
      writerName: resolved.comment.resolvedBy?.name ?? "",
    });
    if (notice) await this.notices().resolve(notice);
    return { changed: true as const };
  }

  async reopen(input: Place & { commentId: string }) {
    const reopened = await reopenComment(this.db, personPrincipal(input), {
      artifact: input.artifactId,
      comment: input.commentId,
    });
    if (reopened.changed)
      await announceArtifactComments(this.signals, input.workspaceId, reopened.artifact, {
        change: "reopened",
        commentIds: [input.commentId],
      });
    return { changed: reopened.changed };
  }

  async uploadImage(input: Place & { bytes: Uint8Array<ArrayBuffer> }) {
    await this.admit(input.userId);
    await this.readable(input);
    if (input.bytes.length > ARTIFACT_COMMENT_IMAGE_MAX_BYTES)
      throw new AppError("INVALID_INPUT", {
        errorId: "artifact-image-too-large",
        hint: "a comment image is at most 10 MiB",
      });
    const { sha256 } = await storeCleanImage(
      this.blobs,
      personPrincipal(input),
      input.bytes,
      ARTIFACT_UNREFERENCED_QUOTA_BYTES,
    ).catch((error: unknown) => {
      throw error instanceof ArtifactStorageFull
        ? new AppError("INVALID_INPUT", { errorId: "artifact-storage-full" })
        : error;
    });
    return { sha256 };
  }

  async readImage(input: Place & { imageId: string }) {
    return readCommentImageBytes(this.db, this.blobs, personPrincipal(input), {
      artifact: input.artifactId,
      image: input.imageId,
    });
  }

  private async readable(input: Place) {
    return requireReadableArtifact(
      this.db,
      input.workspaceId,
      { userId: input.userId },
      input.artifactId,
    );
  }

  private async admit(userId: string) {
    const decision = await this.limit?.admit(userId);
    if (decision && !decision.allowed) throw artifactRateLimited(decision.retryAfterSeconds);
  }

  private notices() {
    return new ArtifactNotices(this.db, this.port);
  }
}
