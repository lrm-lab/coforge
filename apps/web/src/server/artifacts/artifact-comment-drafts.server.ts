import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  COMMENT_DRAFTS_MAX,
  type DraftCreateInput,
} from "#src/features/artifacts/artifact-comment-draft-inputs";
import { hasTextOrImage } from "#src/features/artifacts/artifact-comment-inputs";
import { AppError } from "#src/lib/app-error";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { artifactsDisabled } from "./artifact-access.server";
import { requireReadableArtifact } from "./artifact-comment-access.server";
import {
  COMMENT_DRAFT_TTL_MS,
  DRAFT_SELECT,
  draftExpiryFrom,
  draftNotFound,
  draftView,
  imagesOf,
  lockDrafts,
  lockedDrafts,
} from "./artifact-comment-draft-rows.server";
import { sweepExpiredDrafts } from "./artifact-comment-draft-sweep.server";
import { submitDrafts, type DraftSubmitDeps } from "./artifact-comment-drafts-submit.server";
import {
  prepareImages,
  useImageBlobs,
  type CommentImageBlobs,
} from "./artifact-comment-images.server";
import { personPrincipal } from "./artifact-comment-principal.server";
import { prepareComments, WRITE_TIMEOUT_MS, type CommentTx } from "./artifact-comment-write.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";
import type { ArtifactSignals } from "./artifact-signals.server";
import { artifactRateLimited } from "./artifact-rate-limited-response.server";

type Place = { workspaceId: string; artifactId: string; userId: string };

type Blobs = CommentImageBlobs & Pick<StoredArtifactBlobs, "release">;

export class ArtifactCommentDrafts {
  constructor(
    private readonly db: PrismaClient,
    private readonly blobs: Blobs,
    private readonly enabled: (workspaceId: string) => Promise<boolean>,
    private readonly port: ArtifactNoticePort,
    private readonly signals?: ArtifactSignals,
    private readonly limit?: AppRateLimit,
  ) {}

  async list(input: Place) {
    await this.readable(input);
    const rows = await this.db.artifactCommentDraft.findMany({
      where: { artifactId: input.artifactId, userId: input.userId, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: DRAFT_SELECT,
    });
    return { drafts: rows.map(draftView), limit: COMMENT_DRAFTS_MAX };
  }

  async create(input: Place & { draft: Omit<DraftCreateInput, "artifactId"> }) {
    await this.admit(input.userId);
    const artifact = await this.readable(input);
    const { workspaceId, userId } = input;
    const {
      version,
      body,
      path,
      anchor,
      replyTo,
      createdAt: restoredAt,
      images: shas = [],
    } = input.draft;
    const images = await prepareImages(this.blobs, personPrincipal(input), shas);
    const row = await this.db.$transaction(
      async (tx) => {
        await lockDrafts(tx, artifact.id, userId);
        const now = new Date();
        const where = { artifactId: artifact.id, userId, expiresAt: { gt: now } };
        const held = await tx.artifactCommentDraft.count({ where });
        if (held >= COMMENT_DRAFTS_MAX)
          throw new AppError("CONFLICT", {
            errorId: "artifact-draft-limit",
            details: { limit: COMMENT_DRAFTS_MAX },
            hint: `a person keeps at most ${COMMENT_DRAFTS_MAX} drafts on an artifact`,
          });
        await prepareComments(tx, artifact.id, [{ body, path, anchor, replyTo }], { version });
        await useImageBlobs(tx, this.blobs, workspaceId, images);
        const createdAt = await this.creationTime(tx, where, now, restoredAt);
        return tx.artifactCommentDraft.create({
          data: {
            artifactId: artifact.id,
            userId,
            version,
            body,
            ...(path === undefined ? {} : { path }),
            ...(anchor ? { anchor: anchor as Prisma.InputJsonObject } : {}),
            ...(replyTo === undefined ? {} : { replyTo }),
            images: images as unknown as Prisma.InputJsonArray,
            createdAt,
            expiresAt: draftExpiryFrom(now),
          },
          select: DRAFT_SELECT,
        });
      },
      { timeout: WRITE_TIMEOUT_MS },
    );
    return draftView(row);
  }

  async edit(input: Place & { draftId: string; body: string }) {
    const artifact = await this.readable(input);
    const row = await this.db.$transaction(
      async (tx) => {
        await lockDrafts(tx, artifact.id, input.userId);
        const now = new Date();
        const [held] = await lockedDrafts(tx, {
          artifactId: artifact.id,
          userId: input.userId,
          now,
          ids: [input.draftId],
        });
        if (!held) throw draftNotFound();
        if (!hasTextOrImage({ body: input.body, images: imagesOf(held) }))
          throw new AppError("INVALID_INPUT", { errorId: "artifact-comment-body" });
        return tx.artifactCommentDraft.update({
          where: { id: held.id },
          data: { body: input.body, expiresAt: draftExpiryFrom(now) },
          select: DRAFT_SELECT,
        });
      },
      { timeout: WRITE_TIMEOUT_MS },
    );
    return draftView(row);
  }

  async remove(input: Place & { draftId: string }) {
    const removed = await this.discard(input, [input.draftId]);
    return { removed: removed > 0 };
  }

  async discardAll(input: Place) {
    return { removed: await this.discard(input) };
  }

  async submit(input: Place & { draftIds: readonly string[]; clientKey: string }) {
    await this.admit(input.userId);
    const artifact = await this.readable(input);
    return submitDrafts(this.submitDeps(), { ...input, artifact });
  }

  async readImage(input: Place & { draftId: string; position: number }) {
    await this.readable(input);
    const row = await this.db.artifactCommentDraft.findFirst({
      where: {
        id: input.draftId,
        artifactId: input.artifactId,
        userId: input.userId,
        expiresAt: { gt: new Date() },
      },
      select: DRAFT_SELECT,
    });
    const image = row ? imagesOf(row)[input.position] : undefined;
    const bytes = image ? await this.blobs.read(input.workspaceId, image.sha256) : null;
    if (!image || !bytes) throw draftNotFound();
    return { contentType: image.contentType, bytes };
  }

  sweepExpired(now: Date = new Date()) {
    return sweepExpiredDrafts(this.db, this.blobs, now);
  }

  private async discard(input: Place, ids?: readonly string[]): Promise<number> {
    const artifact = await this.readable(input);
    return this.db.$transaction(
      async (tx) => {
        await lockDrafts(tx, artifact.id, input.userId);
        const rows = await lockedDrafts(tx, {
          artifactId: artifact.id,
          userId: input.userId,
          now: new Date(),
          ...(ids ? { ids } : {}),
        });
        if (rows.length === 0) return 0;
        await tx.artifactCommentDraft.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });
        const shas = [
          ...new Set(rows.flatMap((row) => imagesOf(row).map((image) => image.sha256))),
        ];
        await this.blobs.release(tx, input.workspaceId, shas.sort());
        return rows.length;
      },
      { timeout: WRITE_TIMEOUT_MS },
    );
  }

  private async creationTime(
    tx: CommentTx,
    where: Prisma.ArtifactCommentDraftWhereInput,
    now: Date,
    restoredAt: Date | undefined,
  ) {
    if (restoredAt)
      return new Date(
        Math.min(
          now.getTime(),
          Math.max(restoredAt.getTime(), now.getTime() - COMMENT_DRAFT_TTL_MS),
        ),
      );
    const last = await tx.artifactCommentDraft.findFirst({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true },
    });
    return new Date(Math.max(now.getTime(), (last?.createdAt.getTime() ?? 0) + 1));
  }

  private submitDeps(): DraftSubmitDeps {
    return { db: this.db, blobs: this.blobs, port: this.port, signals: this.signals };
  }

  private async readable(input: Place) {
    if (!(await this.enabled(input.workspaceId))) throw artifactsDisabled();
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
}
