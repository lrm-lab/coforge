import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { CommentAnchor } from "#src/features/artifacts/artifact-comment-inputs";
import { AppError, isAppError } from "#src/lib/app-error";
import { COMMENT_SELECT, type CommentRow } from "./artifact-comment-view.server";

/** What a comment write runs in: one transaction holding the artifact's comment lock. */
export type CommentTx = Prisma.TransactionClient;

/** A write of comments is slow only when it is a review of fifty; the default five seconds is
 * for one statement's worth of work. */
const WRITE_TIMEOUT_MS = 15_000;

/**
 * Takes the artifact's comment lock for the rest of the transaction. A transaction that also locks
 * the artifact's row (a push) takes this one first: a comment write holds this lock and then needs
 * the row, so the other order could deadlock.
 */
export const lockComments = (tx: CommentTx, artifactId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`artifact-comments:${artifactId}`}, 0))`;

/**
 * Runs `work` in a transaction that holds the artifact's comment lock, so one artifact's comment
 * writes go one at a time. The gate, the replay lookup, the stamp and the insert then see the same
 * comments: nothing lands between the gate and the insert, and a comment committed later is
 * stamped later (`nextStamp`), which the unseen position depends on. An Agent's push takes the
 * same lock, so it does not slip between a comment's check and its commit either.
 */
export function withCommentLock<T>(
  db: PrismaClient,
  artifactId: string,
  work: (tx: CommentTx) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await lockComments(tx, artifactId);
      return work(tx);
    },
    { timeout: WRITE_TIMEOUT_MS },
  );
}

/** The artifact's current version, read once the lock is held: what a comment is written on. */
export async function currentVersionOf(tx: CommentTx, artifactId: string): Promise<number> {
  const { currentVersion } = await tx.artifact.findUniqueOrThrow({
    where: { id: artifactId },
    select: { currentVersion: true },
  });
  return currentVersion;
}

/**
 * The time to stamp a write that holds the lock: the database's clock, and strictly after the
 * artifact's newest comment, so the (`createdAt`, `id`) order is the order the writes committed
 * in, whatever the web servers' clocks say. `count` comments of one review take it and the
 * `count - 1` milliseconds after it, one each (`insertComments`). One statement: `GREATEST`
 * ignores the NULL an artifact with no comment gives.
 */
export async function nextStamp(tx: CommentTx, artifactId: string): Promise<Date> {
  const [row] = await tx.$queryRaw<{ stamp: Date }[]>`
    SELECT GREATEST(
      date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
      MAX("createdAt") + interval '1 millisecond'
    ) AS "stamp"
    FROM "artifact_comments" WHERE "artifactId" = ${artifactId}::uuid`;
  return row!.stamp;
}

/** A comment as its author wrote it. */
export type CommentDraft = {
  body: string;
  path?: string | undefined;
  anchor?: CommentAnchor | undefined;
  replyTo?: string | undefined;
};

/** A comment's resolved shape: where it goes and which thread it joins. */
export type PreparedComment = {
  body: string;
  path: string | null;
  anchor: CommentAnchor | null;
  /** The thread's root: the comment a reply names, or that comment's own root. */
  rootId: string | null;
  version: number;
};

/** The same comment error, naming the comment of a review it is about. */
function atIndex(error: unknown, index: number): unknown {
  if (!isAppError(error)) return error;
  return new AppError(error.code, {
    ...(error.errorId ? { errorId: error.errorId } : {}),
    details: { ...error.details, index },
    hint: `comments[${index}]: ${error.hint ?? "refused"}`,
  });
}

/**
 * Drafts made ready to store, or the refusal of the first that cannot be (with `indexed`, naming
 * its index). Read once for all: the version they are written on (the current one by default), the
 * comments they answer (one of this artifact's, whose thread a draft joins and whose path it
 * inherits unless it names its own) and the files they name. An anchor points into a file, so it
 * needs a path. A path a draft names must be a file of that version, and so must the path it
 * inherits when it names a version: a reply to an older comment on an older version is still on a
 * file that version has. Called with the comment lock held.
 */
export async function prepareComments(
  tx: CommentTx,
  artifactId: string,
  drafts: readonly CommentDraft[],
  options: { version?: number | undefined; indexed?: boolean },
): Promise<PreparedComment[]> {
  const current = await currentVersionOf(tx, artifactId);
  const version = options.version ?? current;
  if (version > current)
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-comment-version",
      hint: `the artifact has ${current} version${current === 1 ? "" : "s"}`,
    });
  const replyIds = [...new Set(drafts.flatMap((draft) => draft.replyTo ?? []))];
  const targets = new Map(
    (replyIds.length
      ? await tx.artifactComment.findMany({
          where: { id: { in: replyIds }, artifactId },
          select: { id: true, rootId: true, path: true },
        })
      : []
    ).map((row) => [row.id, row]),
  );
  const named = new Set<string>();
  for (const draft of drafts) {
    if (draft.path !== undefined) named.add(draft.path);
    const inherited = draft.replyTo ? targets.get(draft.replyTo)?.path : undefined;
    if (inherited && options.version !== undefined) named.add(inherited);
  }
  const files = new Set(
    (named.size
      ? await tx.artifactFile.findMany({
          where: { artifactId, path: { in: [...named] }, version: { number: version } },
          select: { path: true },
        })
      : []
    ).map((file) => file.path),
  );
  return drafts.map((draft, index) => {
    try {
      const target = draft.replyTo ? targets.get(draft.replyTo) : undefined;
      if (draft.replyTo && !target)
        throw new AppError("NOT_FOUND", {
          errorId: "artifact-comment-not-found",
          hint: `this artifact has no comment ${draft.replyTo} to reply to`,
        });
      const path = draft.path ?? target?.path ?? null;
      if (draft.anchor && path === null)
        throw new AppError("INVALID_INPUT", {
          errorId: "artifact-comment-anchor",
          hint: "an anchor points into a file: name its path",
        });
      if (
        path !== null &&
        (draft.path !== undefined || options.version !== undefined) &&
        !files.has(path)
      )
        throw new AppError("INVALID_INPUT", {
          errorId: "artifact-comment-path",
          hint: `version ${version} has no file ${path}`,
        });
      return {
        body: draft.body,
        path,
        anchor: draft.anchor ?? null,
        rootId: target ? (target.rootId ?? target.id) : null,
        version,
      };
    } catch (error) {
      throw options.indexed ? atIndex(error, index) : error;
    }
  });
}

/**
 * Stores prepared comments as the Agent's, in one statement: the first at `stamp`, each next a
 * millisecond after the one before, so they list in the order given. The caller holds the lock and
 * passes the stamp. Answers the rows in that order.
 */
export async function insertComments(
  tx: CommentTx,
  input: {
    artifactId: string;
    agentId: string;
    prepared: readonly PreparedComment[];
    stamp: Date;
    reviewId?: string;
    idempotencyKey?: string;
    requestHash?: string;
  },
): Promise<CommentRow[]> {
  const rows = await tx.artifactComment.createManyAndReturn({
    data: input.prepared.map((prepared, index) => ({
      artifactId: input.artifactId,
      version: prepared.version,
      path: prepared.path,
      ...(prepared.anchor ? { anchor: prepared.anchor as Prisma.InputJsonObject } : {}),
      rootId: prepared.rootId,
      ...(input.reviewId ? { reviewId: input.reviewId } : {}),
      authorAgentId: input.agentId,
      body: prepared.body,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.requestHash ? { requestHash: input.requestHash } : {}),
      createdAt: new Date(input.stamp.getTime() + index),
    })),
    select: COMMENT_SELECT,
  });
  return rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

/** What a thread's root holds while it is open. */
export const CLEARED_RESOLUTION = {
  resolvedAt: null,
  resolvedByUserId: null,
  resolvedByAgentId: null,
} as const;

/** Clears the resolution of roots, in one statement; a root that is open is left alone. */
export function reopenThreads(tx: CommentTx, rootIds: readonly string[]) {
  return tx.artifactComment.updateMany({
    where: { id: { in: [...rootIds] }, resolvedAt: { not: null } },
    data: CLEARED_RESOLUTION,
  });
}
