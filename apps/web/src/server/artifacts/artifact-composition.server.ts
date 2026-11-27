import type { PrismaClient } from "#src/generated/prisma/client";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { StoredArtifactBlobs } from "./artifact-blobs.server";
import { ArtifactDocuments } from "./artifact-documents.server";
import { centrifugoArtifactSignals } from "./artifact-signals.server";
import { Artifacts } from "./artifacts.server";
import { readSessionSecret } from "#src/server/auth/config.server";
import { actorNames } from "./artifact-actor-names.server";
import { ArtifactPageAssets } from "./artifact-page-assets.server";
import { ArtifactPageData } from "./artifact-page-data.server";
import { ArtifactSandbox } from "./artifact-sandbox.server";
import { productionTicketNonces } from "./artifact-sandbox-nonces.server";
import { artifactApplicationOrigin, artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import { ArtifactPublicLinks } from "./artifact-public-links.server";
import { linkPageLookup, publicPageLookup } from "./artifact-public-page.server";
import { ArtifactAbuseReporter } from "./artifact-public-abuse.server";
import { ArtifactLinkOpen } from "./artifact-link-open.server";
import { PublicArtifactMissGuard } from "./artifact-public-miss-guard.server";
import { getAppRateLimits } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import { type ArtifactActor } from "./artifact-access.server";
import { ArtifactReads, type ArtifactMessageCard } from "./artifact-reads.server";
import { ArtifactShares } from "./artifact-shares.server";
import { artifactDownload, artifactFilePreview } from "./artifact-download.server";
import { artifactThumbnail } from "./artifact-thumbnail.server";
import { ArtifactGallery } from "./artifact-gallery.server";
import { ArtifactCommentDrafts } from "./artifact-comment-drafts.server";
import { ArtifactPersonComments } from "./artifact-person-comments.server";
import { commentImageUploadResponse } from "./artifact-comment-image-upload.server";
import { ArtifactPersonFollows } from "./artifact-person-follows.server";
import { ArtifactRenames } from "./artifact-rename.server";
import { ArtifactVersionHistory } from "./artifact-version-history.server";
import { ArtifactViewerPositions } from "./artifact-viewer-positions.server";
import type { ArtifactNotice, ArtifactNoticePort } from "./artifact-notice-port.server";
import {
  saveAttachmentAsArtifact,
  type ArtifactAttachmentPort,
} from "./agent-artifact-save.server";
import { AppError, isAppError } from "#src/lib/app-error";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { createSystemAgentEvents } from "#src/server/app-agent-events/app-agent-events-composition.server";
import { artifactCheckConfig, artifactChecksEnabled } from "./artifact-check-config.server";
import { enqueueArtifactVersionCheckFromActiveQueue } from "./artifact-check-queue.server";
import { createHttpArtifactCheckRunner } from "./artifact-check-runner.server";
import { ArtifactChecks } from "./artifact-checks.server";
import { ArtifactPinnedSummary } from "./artifact-pinned-summary.server";
import { ArtifactSettlements } from "./artifact-settlement.server";
export type { ArtifactMessageCard } from "./artifact-reads.server";
export type { PinnedArtifactSummary } from "./artifact-pinned-summary.server";
export type {
  ArtifactReopenedView,
  ArtifactSettledView,
  ArtifactSettlementView,
} from "./artifact-settlement.server";
export { memberArtifactWorkspaceSlug } from "./artifact-public-page.server";

export const productionArtifactSignals = () =>
  centrifugoArtifactSignals(() => createCentrifugoServerApi());

export function productionArtifactReads(db: PrismaClient) {
  return new ArtifactReads(db);
}

export function productionArtifacts(db: PrismaClient) {
  const blobs = new StoredArtifactBlobs(db, getFileStorage);
  const artifacts = new Artifacts(db, blobs, { signals: productionArtifactSignals() });
  const comments = new ArtifactPersonComments(
    db,
    blobs,
    productionArtifactNotices(db),
    productionArtifactSignals(),
    getAppRateLimits().artifactPersonComment,
  );
  const drafts = new ArtifactCommentDrafts(
    db,
    blobs,
    productionArtifactNotices(db),
    productionArtifactSignals(),
    getAppRateLimits().artifactPersonComment,
  );
  const documents = new ArtifactDocuments(db, artifacts, blobs);
  return {
    artifacts,
    blobs,
    drafts,
    documents,
    visibility: artifacts.visibility,
    publicLinks: new ArtifactPublicLinks(db, productionArtifactSignals()),
    gallery: new ArtifactGallery(db, artifacts.reads),
    renames: new ArtifactRenames(db, artifacts.reads, productionArtifactNotices(db)),
    personFollows: new ArtifactPersonFollows(db, artifacts.reads),
    comments,
    uploadCommentImage: (
      request: Request,
      place: { workspaceId: string; artifactId: string; userId: string },
    ) => commentImageUploadResponse(request, (bytes) => comments.uploadImage({ ...place, bytes })),
    versionHistory: new ArtifactVersionHistory(db, artifacts.reads),
    viewerPositions: new ArtifactViewerPositions(db, artifacts.reads),
    pinnedSummary: new ArtifactPinnedSummary(db),
    settlements: new ArtifactSettlements(db),
    download: (input: Parameters<typeof artifactDownload>[1]) =>
      artifactDownload(
        { reads: artifacts.reads, blobs, zipLimit: getAppRateLimits().artifactZip },
        input,
      ),
    filePreview: (input: Parameters<typeof artifactFilePreview>[1]) =>
      artifactFilePreview({ reads: artifacts.reads, blobs }, input),
    thumbnail: (input: Parameters<typeof artifactThumbnail>[1]) =>
      artifactThumbnail({ reads: artifacts.reads, blobs }, input),
    saveAttachment: async (input: { workspaceId: string; userId: string; attachmentId: string }) =>
      saveAttachmentAsArtifact(
        { db, documents, blobs, attachments: productionArtifactAttachments(db) },
        { workspaceId: input.workspaceId, userId: input.userId },
        input.attachmentId,
      ),
  };
}

export function productionArtifactAttachments(db: PrismaClient): ArtifactAttachmentPort {
  return {
    async read({ workspaceId, agentId, userId }, attachmentId) {
      try {
        const { attachment, open } = await readAuthorizedAttachment(db, {
          attachmentId,
          workspaceId,
          agentId,
          userId,
        });
        if (!attachment.messageId) return null;
        return {
          id: attachment.id,
          messageId: attachment.messageId,
          conversationId: attachment.conversationId,
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          bytes: async () => {
            const file = await open();
            if (!file) throw new AppError("TEMPORARILY_UNAVAILABLE");
            return new Uint8Array(await new Response(file.body).arrayBuffer());
          },
        };
      } catch (error) {
        if (isAppError(error) && (error.code === "NOT_FOUND" || error.code === "ACCESS_DENIED"))
          return null;
        throw error;
      }
    },
  };
}

export function productionArtifactPage(db: PrismaClient) {
  const { artifacts, blobs } = productionArtifacts(db);
  return {
    data: new ArtifactPageData(db, artifacts.reads, productionArtifactSignals()),
    assets: new ArtifactPageAssets(db, artifacts.reads, blobs),
  };
}

export function productionArtifactNotices(db: PrismaClient): ArtifactNoticePort {
  const events = createSystemAgentEvents(db);
  const notice = ({ workspaceId, agentId, key, content }: ArtifactNotice) => ({
    source: "system.artifacts" as const,
    sourceName: "CoForge artifacts",
    workspaceId,
    agentId,
    key,
    message: content,
  });
  return {
    deliver: (input) => events.deliver(notice(input)),
    stage: (scope, input) => events.stage(scope, notice(input)),
  };
}

export function productionArtifactShares(db: PrismaClient) {
  return new ArtifactShares(db);
}

let linkMissGuard: PublicArtifactMissGuard | undefined;

function productionLinkMissGuard() {
  linkMissGuard ??= new PublicArtifactMissGuard({
    perClient: getAppRateLimits().publicArtifactMiss,
    global: getAppRateLimits().publicArtifactMissGlobal,
    now: Date.now,
  });
  return linkMissGuard;
}

export function productionArtifactLinkOpen(db: PrismaClient) {
  return new ArtifactLinkOpen({
    perClient: getAppRateLimits().publicArtifact,
    perArtifact: getAppRateLimits().publicArtifactPerArtifact,
    lookup: linkPageLookup(db),
    guard: productionLinkMissGuard(),
    origin: artifactSandboxOrigin(),
  });
}

export function productionArtifactAbuseReporter(db: PrismaClient) {
  return new ArtifactAbuseReporter({
    perClient: getAppRateLimits().publicArtifact,
    lookup: linkPageLookup(db),
  });
}

export function productionArtifactSandbox(db: PrismaClient) {
  const { artifacts, blobs } = productionArtifacts(db);
  return new ArtifactSandbox({
    reads: artifacts.reads,
    pageAssets: new ArtifactPageAssets(db, artifacts.reads, blobs),
    readBlob: (workspaceId, sha256) => blobs.read(workspaceId, sha256),
    origin: artifactSandboxOrigin(),
    nonces: productionTicketNonces(),
    viewerName: async (workspaceId, userId) =>
      (await actorNames(db, workspaceId, { userIds: [userId], agentIds: [] })).get(userId) ?? "",
    publicRateLimit: getAppRateLimits().publicArtifact,
    publicFileRateLimit: getAppRateLimits().publicArtifactFile,
    secret: () => readSessionSecret(process.env),
    now: () => new Date(),
    publicPage: publicPageLookup(db),
    linkPage: linkPageLookup(db),
    missGuard: productionLinkMissGuard(),
    linkArtifactLimit: getAppRateLimits().publicArtifactPerArtifact,
    appOrigin: () => artifactApplicationOrigin(),
  });
}

export function artifactMessageCards(
  db: PrismaClient,
  input: {
    workspaceId: string;
    reader: ArtifactActor;
    messages: readonly { body: string }[];
  },
): Promise<ArtifactMessageCard[][]> {
  return productionArtifactReads(db).messageCards(input);
}

export function productionArtifactChecks(db: PrismaClient) {
  const blobs = new StoredArtifactBlobs(db, getFileStorage);
  const reads = new ArtifactReads(db);
  return new ArtifactChecks({
    db,
    reads,
    blobs,
    enabled: () => artifactChecksEnabled(),
    runner: () => {
      const config = artifactCheckConfig();
      return config ? createHttpArtifactCheckRunner(config) : null;
    },
    enqueue: enqueueArtifactVersionCheckFromActiveQueue,
    timeoutMs: () => artifactCheckConfig()?.timeoutMs ?? 45_000,
    dailyCap: () => artifactCheckConfig()?.dailyCap ?? 200,
  });
}
