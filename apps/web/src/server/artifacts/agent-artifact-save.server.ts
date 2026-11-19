import { ARTIFACT_TITLE_MAX } from "#src/features/artifacts/artifact-title-limit";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import type { ArtifactActor } from "./artifact-access.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import type { ArtifactDocuments } from "./artifact-documents.server";
import {
  ARTIFACT_BINARY_LIMIT,
  ARTIFACT_TEXT_LIMIT,
  artifactPathValid,
} from "./artifact-files.server";

export type ArtifactAttachmentPrincipal =
  | { workspaceId: string; agentId: string; userId?: undefined }
  | { workspaceId: string; userId: string; agentId?: undefined };

export type ArtifactAttachment = {
  id: string;
  messageId: string;
  conversationId: string;
  fileName: string;
  contentType?: string | undefined;
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

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "heic",
  "heif",
  "bmp",
  "pdf",
  "mp4",
  "webm",
  "mov",
  "mp3",
  "m4a",
  "ogg",
  "wav",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "zip",
  "gz",
  "tar",
  "7z",
  "rar",
  "bz2",
  "xz",
  "zst",
  "docx",
  "xlsx",
  "pptx",
  "doc",
  "xls",
  "ppt",
  "wasm",
  "bin",
  "exe",
  "dmg",
]);

const BINARY_APPLICATION_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
  "application/msword",
  "application/wasm",
]);

const notFound = () =>
  new AppError("NOT_FOUND", {
    errorId: "artifact-attachment-not-found",
    hint: "no attachment you can read has that id: `coforge message read` lists a message's attachments",
  });

const attachmentNotSavable = () =>
  new AppError("INVALID_INPUT", {
    errorId: "artifact-attachment-not-savable",
    hint: "an artifact file is at most 16 MiB (15 MiB when it is not text)",
  });

function isKnownBinaryAttachment(attachment: {
  fileName: string;
  contentType?: string | undefined;
}): boolean {
  const mime = attachment.contentType?.split(";")[0]?.trim().toLowerCase();
  if (mime && mime !== "application/octet-stream") {
    if (mime.startsWith("image/")) return mime !== "image/svg+xml";
    if (mime.startsWith("video/") || mime.startsWith("audio/") || mime.startsWith("font/"))
      return true;
    if (mime.startsWith("application/vnd."))
      return !mime.endsWith("+json") && !mime.endsWith("+xml");
    return BINARY_APPLICATION_TYPES.has(mime);
  }
  const name = attachment.fileName.trim();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

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
  const sizeLimit = isKnownBinaryAttachment(attachment)
    ? ARTIFACT_BINARY_LIMIT
    : ARTIFACT_TEXT_LIMIT;
  if (attachment.sizeBytes > sizeLimit) throw attachmentNotSavable();
  let blob: Awaited<ReturnType<SaveServices["blobs"]["upload"]>>;
  try {
    blob = await services.blobs.upload({
      workspaceId: principal.workspaceId,
      bytes: await attachment.bytes(),
      actor,
      unreferencedQuotaBytes: UNSAVED_UPLOADS_QUOTA_BYTES,
    });
  } catch (error) {
    if (isAppError(error) && error.errorId === "artifact-file-too-large")
      throw attachmentNotSavable();
    throw error;
  }
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
