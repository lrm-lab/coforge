import type { PrismaClient } from "#src/generated/prisma/client";
import { COMMENT_HANDLES_RESOLVED_MAX } from "#src/features/artifacts/artifact-comment-inputs";
import type { DraftRefusalReason } from "#src/features/artifacts/artifact-comment-draft-inputs";
import { isAppError } from "#src/lib/app-error";
import { payloadHash } from "#src/server/canonical-hash.server";
import type { CommentedArtifact } from "./artifact-comment-access.server";
import {
  DRAFT_SELECT,
  draftsChanged,
  imagesOf,
  lockDrafts,
  lockedDrafts,
  type DraftRow,
} from "./artifact-comment-draft-rows.server";
import { attachImages, type CommentImageBlobs } from "./artifact-comment-images.server";
import { COMMENT_ORDER } from "./artifact-comment-unseen.server";
import { REVIEW_SELECT, reviewViews } from "./artifact-comment-view.server";
import {
  insertComments,
  nextStamp,
  prepareComments,
  reopenThreads,
  withCommentLock,
  type CommentTx,
  type PreparedComment,
} from "./artifact-comment-write.server";
import {
  peopleMentionedIn,
  reviewMentions,
  writeMentions,
} from "./artifact-comment-mention-rows.server";
import { idempotencyMismatch } from "./artifact-idempotency.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";
import { mentionHandles } from "./artifact-notice-mentions.server";
import { ArtifactNotices, mentionCheckOf, requireMentionable } from "./artifact-notices.server";
import { settleWrite } from "./artifact-activity-wake.server";
import { startFollowing } from "./artifact-follows.server";
import { announceArtifactComments, type ArtifactSignals } from "./artifact-signals.server";

export type DraftSubmitDeps = {
  db: PrismaClient;
  blobs: CommentImageBlobs;
  port: ArtifactNoticePort;
  signals?: ArtifactSignals | undefined;
};

type SubmitInput = {
  workspaceId: string;
  userId: string;
  artifact: CommentedArtifact;
  draftIds: readonly string[];
  clientKey: string;
};

export type Sent = {
  status: "sent";
  reviewId: string;
  commentIds: string[];
  notified?: { name: string }[];
};

export type Rejected = {
  status: "rejected";
  draftId: string;
  reason: DraftRefusalReason;
  names?: string[];
};

type Refusal = { reason: DraftRefusalReason; names?: string[] };

const REFUSAL_BY_ERROR: Record<string, DraftRefusalReason> = {
  "artifact-comment-path": "file-gone",
  "artifact-comment-version": "version-gone",
  "artifact-comment-not-found": "reply-gone",
  "artifact-too-many-mentions": "too-many-mentions",
  "artifact-mention-cannot-see": "mention-cannot-see",
};

function refusalOf(error: unknown): Refusal | undefined {
  if (!isAppError(error) || !error.errorId) return undefined;
  const names = error.details?.names;
  return {
    reason: REFUSAL_BY_ERROR[error.errorId] ?? "invalid",
    ...(typeof names === "string" ? { names: names.split(",") } : {}),
  };
}

const rejected = (draftId: string, refusal: Refusal): Rejected => ({
  status: "rejected",
  draftId,
  ...refusal,
});

function sameSet(rows: readonly { id: string }[], ids: readonly string[]) {
  const wanted = new Set(ids);
  return wanted.size === rows.length && rows.every((row) => wanted.has(row.id));
}

function sameDrafts(rows: readonly DraftRow[], shown: readonly DraftRow[]) {
  return (
    rows.length === shown.length &&
    rows.every((row, at) => {
      const held = shown[at]!;
      return row.id === held.id && row.body === held.body;
    })
  );
}

async function mentionRefusals(
  notices: ArtifactNotices,
  input: { workspaceId: string; artifact: CommentedArtifact },
  rows: readonly DraftRow[],
): Promise<(Refusal | undefined)[]> {
  const handles = rows.map(
    (row) => new Set(mentionHandles(row.body, COMMENT_HANDLES_RESOLVED_MAX)),
  );
  const mentioning = rows.filter((_, at) => handles[at]!.size > 0);
  if (mentioning.length === 0) return rows.map(() => undefined);
  const { entries } = await notices.recipients(input, {
    texts: mentioning.map((row) => row.body),
    handlesPerText: COMMENT_HANDLES_RESOLVED_MAX,
  });
  return rows.map((_, at) => {
    try {
      requireMentionable(mentionCheckOf(entries, handles[at]!));
      return undefined;
    } catch (error) {
      return refusalOf(error);
    }
  });
}

async function prepareAll(
  tx: CommentTx,
  artifactId: string,
  rows: readonly DraftRow[],
  mentions: readonly (Refusal | undefined)[],
): Promise<{ prepared: PreparedComment[] } | Rejected> {
  const prepared: PreparedComment[] = new Array(rows.length);
  const firstMention = mentions.findIndex((refusal) => refusal !== undefined);
  let refused: { at: number; refusal: Refusal } | undefined =
    firstMention < 0 ? undefined : { at: firstMention, refusal: mentions[firstMention]! };
  for (const version of new Set(rows.map((row) => row.version))) {
    const group = rows.flatMap((row, at) => (row.version === version ? [{ row, at }] : []));
    try {
      const done = await prepareComments(
        tx,
        artifactId,
        group.map(({ row }) => ({
          body: row.body,
          ...(row.path === null ? {} : { path: row.path }),
          ...(row.anchor === null ? {} : { anchor: row.anchor as never }),
          ...(row.replyTo === null ? {} : { replyTo: row.replyTo }),
        })),
        { version, indexed: true },
      );
      for (const [index, entry] of done.entries()) prepared[group[index]!.at] = entry;
    } catch (error) {
      const refusal = refusalOf(error);
      if (!refusal || !isAppError(error)) throw error;
      const index = error.details?.index;
      const at = group[typeof index === "number" ? index : 0]!.at;
      if (!refused || at < refused.at) refused = { at, refusal };
    }
  }
  if (refused) return rejected(rows[refused.at]!.id, refused.refusal);
  return { prepared };
}

export async function submitDrafts(
  deps: DraftSubmitDeps,
  input: SubmitInput,
): Promise<Sent | Rejected> {
  const { db, blobs } = deps;
  const { workspaceId, userId, artifact, clientKey } = input;
  const notices = new ArtifactNotices(db, deps.port);
  const requestHash = payloadHash({
    operation: "draft-review",
    draftIds: [...input.draftIds].sort(),
  });
  const keyed = { artifactId: artifact.id, authorUserId: userId, idempotencyKey: clientKey };
  const replayOf = async (tx: Pick<PrismaClient, "artifactCommentReview" | "artifactComment">) => {
    const earlier = await tx.artifactCommentReview.findFirst({
      where: keyed,
      select: { ...REVIEW_SELECT, requestHash: true },
    });
    if (!earlier) return undefined;
    if (earlier.requestHash !== requestHash) throw idempotencyMismatch();
    const rows = await tx.artifactComment.findMany({
      where: { reviewId: earlier.id },
      orderBy: [...COMMENT_ORDER],
      select: { id: true },
    });
    return { status: "sent", reviewId: earlier.id, commentIds: rows.map(({ id }) => id) } as const;
  };
  const replay = await replayOf(db);
  if (replay) return replay;

  const shown = await db.artifactCommentDraft.findMany({
    where: { artifactId: artifact.id, userId, expiresAt: { gt: new Date() } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: DRAFT_SELECT,
  });
  if (!sameSet(shown, input.draftIds)) throw draftsChanged();
  const mentions = await mentionRefusals(notices, input, shown);

  const people = await peopleMentionedIn(db, workspaceId, [
    "",
    ...shown.map((draft) => draft.body),
  ]);
  const written = await withCommentLock(db, artifact.id, async (tx) => {
    const raced = await replayOf(tx);
    if (raced) return { kind: "replayed" as const, sent: raced };
    await lockDrafts(tx, artifact.id, userId);
    const rows = await lockedDrafts(tx, { artifactId: artifact.id, userId, now: new Date() });
    if (!sameDrafts(rows, shown)) throw draftsChanged();
    const prepared = await prepareAll(tx, artifact.id, rows, mentions);
    if (!("prepared" in prepared)) return { kind: "rejected" as const, rejected: prepared };
    const stamp = await nextStamp(tx, artifact.id);
    const review = await tx.artifactCommentReview.create({
      data: {
        artifactId: artifact.id,
        version: Math.max(...rows.map((row) => row.version)),
        authorUserId: userId,
        idempotencyKey: clientKey,
        requestHash,
        createdAt: stamp,
      },
      select: REVIEW_SELECT,
    });
    const inserted = await insertComments(tx, {
      artifactId: artifact.id,
      author: { userId },
      prepared: prepared.prepared,
      stamp,
      reviewId: review.id,
    });
    await attachImages(tx, blobs, {
      workspaceId,
      artifactId: artifact.id,
      rows: inserted,
      images: rows.map(imagesOf),
    });
    const roots = new Set(prepared.prepared.flatMap((entry) => entry.rootId ?? []));
    if (roots.size) await reopenThreads(tx, [...roots]);
    await tx.artifactCommentDraft.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    const place = { workspaceId, artifact };
    const readers = await writeMentions(tx, place, reviewMentions(review, inserted, people));
    await startFollowing(tx, artifact.id, [{ userId }]);
    return { kind: "written" as const, review, inserted, readers };
  });
  if (written.kind === "replayed") return written.sent;
  if (written.kind === "rejected") return written.rejected;

  const { review, inserted, readers } = written;
  const sent = {
    status: "sent" as const,
    reviewId: review.id,
    commentIds: inserted.map(({ id }) => id),
  };
  await announceArtifactComments(deps.signals, workspaceId, artifact, {
    change: "posted",
    commentIds: sent.commentIds,
  });
  settleWrite(db, deps.signals, {
    workspaceId,
    artifact,
    writerUserId: userId,
    alsoUserIds: readers,
  });
  const views = await reviewViews(db, workspaceId, review, inserted);
  const told = await notices.review({
    workspaceId,
    artifact,
    writerName: views.review.author.name,
    reviewId: review.id,
    review: { version: review.version, body: review.body },
    comments: views.comments.flatMap((comment) =>
      "deleted" in comment ? [] : [{ path: comment.path, body: comment.body }],
    ),
  });
  return { ...sent, notified: told.notified };
}
