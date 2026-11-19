import { ARTIFACT_TITLE_MAX } from "#src/features/artifacts/artifact-title-limit";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import type { ArtifactActor } from "./artifact-access.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import type { ArtifactDocuments } from "./artifact-documents.server";
import { ARTIFACT_TEXT_LIMIT, artifactPathValid } from "./artifact-files.server";

export type ArtifactAttachmentPrincipal =
  | { workspaceId: string; agentId: string; userId?: undefined }
  | { workspaceId: string; userId: string; agentId?: undefined };

export type ArtifactAttachment = {
  id: string;
  messageId: string;
  conversationId: string;
  fileName: string;
  sizeBytes: number;
  bytes: () => Promise<Uint8Array<ArrayBuffer>>;
};

export type ArtifactAttachmentPort = {
  read: (
    principal: ArtifactAttachmentPrincipal,
    attachmentId: string,
  ) => Promise<ArtifactAttachment | null>;
};

type SaveServices = {
  db: PrismaClient;
  documents: Pick<ArtifactDocuments, "create" | "cards">;
  blobs: Pick<StoredArtifactBlobs, "upload">;
  attachments?: ArtifactAttachmentPort | undefined;
};

const UNSAVED_UPLOADS_QUOTA_BYTES = 1024 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () =>
  new AppError("NOT_FOUND", {
    errorId: "artifact-attachment-not-found",
    hint: "no attachment you can read has that id: `coforge message read` lists a message's attachments",
  });

export function artifactPathOfFileName(fileName: string): string {
  const cleaned = Array.from(fileName, (ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || ch === "\\" || ch === ":" || ch === "/" ? "_" : ch;
  })
    .join("")
    .replace(/^\.+$/, "_")
    .trim();
  const path = cleaned.slice(0, 1024);
  return artifactPathValid(path) ? path : "attachment";
}

function actorOf(principal: ArtifactAttachmentPrincipal): ArtifactActor {
  return principal.agentId !== undefined
    ? { agentId: principal.agentId }
    : { userId: principal.userId };
}

async function savedBefore(
  services: SaveServices,
  scope: { workspaceId: string; actor: ArtifactActor },
  attachment: { id: string; fileName: string },
) {
  const existing = await services.db.artifact.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      originAttachmentId: attachment.id,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!existing) return null;
  const [card] = await services.documents.cards(scope, [existing.id]);
  if (!card)
    throw new AppError("CONFLICT", {
      errorId: "artifact-already-saved",
      hint: "this attachment was saved as an artifact you cannot see: download it (`coforge attachment view`) and push your own copy",
    });
  return {
    artifact: card,
    created: false as const,
    attachment: { id: attachment.id, fileName: attachment.fileName },
  };
}

export async function saveAttachmentAsArtifact(
  services: SaveServices,
  principal: ArtifactAttachmentPrincipal,
  attachmentId: string,
) {
  const actor = actorOf(principal);
  const scope = { workspaceId: principal.workspaceId, actor };
  const attachment = UUID.test(attachmentId)
    ? await services.attachments?.read(principal, attachmentId.toLowerCase())
    : null;
  if (!attachment) throw notFound();
  const before = await savedBefore(services, scope, attachment);
  if (before) return before;
  if (attachment.sizeBytes > ARTIFACT_TEXT_LIMIT)
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-attachment-not-savable",
      hint: "an artifact file is at most 16 MiB (15 MiB when it is not text)",
    });
  const blob = await services.blobs.upload({
    workspaceId: principal.workspaceId,
    bytes: await attachment.bytes(),
    actor,
    unreferencedQuotaBytes: UNSAVED_UPLOADS_QUOTA_BYTES,
  });
  const path = artifactPathOfFileName(attachment.fileName);
  try {
    const artifact = await services.documents.create(scope, {
      conversationId: attachment.conversationId,
      title: [...(attachment.fileName.trim() || path)].slice(0, ARTIFACT_TITLE_MAX).join(""),
      manifest: { files: [{ path, sha256: blob.sha256 }], entryPath: path },
      origin: { messageId: attachment.messageId, attachmentId: attachment.id },
    });
    return {
      artifact,
      created: true as const,
      attachment: { id: attachment.id, fileName: attachment.fileName },
    };
  } catch (error) {
    if (!isAppError(error) || error.code !== "CONFLICT") throw error;
    const raced = await savedBefore(services, scope, attachment);
    if (raced) return raced;
    throw error;
  }
}
