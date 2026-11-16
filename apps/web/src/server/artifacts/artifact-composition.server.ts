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
import { artifactSandboxOrigin } from "./artifact-sandbox-config.server";
import { ArtifactPublicLinks } from "./artifact-public-links.server";
import { publicPageLookup } from "./artifact-public-page.server";
import { getAppRateLimits } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import { artifactsEnabled, type ArtifactActor } from "./artifact-access.server";
import type { ArtifactMessageCard } from "./artifact-reads.server";
import { ArtifactShares } from "./artifact-shares.server";
import { artifactDownload, artifactFilePreview } from "./artifact-download.server";
import { ArtifactGallery } from "./artifact-gallery.server";
import { ArtifactCommentDrafts } from "./artifact-comment-drafts.server";
import { ArtifactPersonComments } from "./artifact-person-comments.server";
import { commentImageUploadResponse } from "./artifact-comment-image-upload.server";
import { ArtifactPersonFollows } from "./artifact-person-follows.server";
import { ArtifactRenames } from "./artifact-rename.server";
import { ArtifactVersionHistory } from "./artifact-version-history.server";
import { ArtifactViewerPositions } from "./artifact-viewer-positions.server";
import { productionArtifactViewing } from "./artifact-viewing.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";
import type { ArtifactAttachmentPort } from "./agent-artifact-save.server";
import { AppError, isAppError } from "#src/lib/app-error";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { createSystemAgentEvents } from "#src/server/app-agent-events/app-agent-events-composition.server";
export type { ArtifactMessageCard } from "./artifact-reads.server";

export const productionArtifactSignals = () =>
  centrifugoArtifactSignals(() => createCentrifugoServerApi());

export function productionArtifacts(db: PrismaClient) {
  const blobs = new StoredArtifactBlobs(db, getFileStorage);
  const artifacts = new Artifacts(db, blobs, { signals: productionArtifactSignals() });
  const comments = new ArtifactPersonComments(
    db,
    blobs,
    (workspaceId) => artifactsEnabled(db, workspaceId),
    productionArtifactNotices(db),
    productionArtifactSignals(),
    getAppRateLimits().artifactPersonComment,
  );
  const drafts = new ArtifactCommentDrafts(
    db,
    blobs,
    (workspaceId) => artifactsEnabled(db, workspaceId),
    productionArtifactNotices(db),
    productionArtifactSignals(),
    getAppRateLimits().artifactPersonComment,
  );
  return {
    artifacts,
    blobs,
    drafts,
    documents: new ArtifactDocuments(db, artifacts, blobs),
    visibility: artifacts.visibility,
    publicLinks: new ArtifactPublicLinks(db),
    gallery: new ArtifactGallery(
      db,
      (workspaceId) => artifactsEnabled(db, workspaceId),
      artifacts.reads,
    ),
    renames: new ArtifactRenames(db, artifacts.reads, productionArtifactNotices(db)),
    personFollows: new ArtifactPersonFollows(db, artifacts.reads),
    comments,
    uploadCommentImage: (
      request: Request,
      place: { workspaceId: string; artifactId: string; userId: string },
    ) => commentImageUploadResponse(request, (bytes) => comments.uploadImage({ ...place, bytes })),
    versionHistory: new ArtifactVersionHistory(db, artifacts.reads),
    viewerPositions: new ArtifactViewerPositions(db, artifacts.reads, productionArtifactViewing()),
    download: (input: Parameters<typeof artifactDownload>[1]) =>
      artifactDownload(
        { reads: artifacts.reads, blobs, zipLimit: getAppRateLimits().artifactZip },
        input,
      ),
    filePreview: (input: Parameters<typeof artifactFilePreview>[1]) =>
      artifactFilePreview({ reads: artifacts.reads, blobs }, input),
  };
}

export function productionArtifactAttachments(db: PrismaClient): ArtifactAttachmentPort {
  return {
    async read({ workspaceId, agentId }, attachmentId) {
      try {
        const { attachment, open } = await readAuthorizedAttachment(db, {
          attachmentId,
          workspaceId,
          agentId,
        });
        if (!attachment.messageId) return null;
        return {
          id: attachment.id,
          messageId: attachment.messageId,
          conversationId: attachment.conversationId,
          fileName: attachment.fileName,
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
  return {
    deliver: ({ workspaceId, agentId, key, content }) =>
      events.deliver({
        source: "system.artifacts",
        sourceName: "CoForge artifacts",
        workspaceId,
        agentId,
        key,
        message: content,
      }),
  };
}

export function productionArtifactShares(
  db: PrismaClient,
  enabled: (workspaceId: string) => Promise<boolean>,
) {
  return new ArtifactShares(db, enabled);
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
  return productionArtifacts(db).artifacts.reads.messageCards(input);
}
