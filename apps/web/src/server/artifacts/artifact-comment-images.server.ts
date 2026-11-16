import { imageSize } from "image-size";
import sharp, { type Sharp } from "sharp";
import {
  ARTIFACT_COMMENT_IMAGE_MAX_BYTES,
  ARTIFACT_COMMENT_IMAGE_MAX_PIXELS,
} from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import type { PrismaClient } from "#src/generated/prisma/client";
import { requireReadableArtifact } from "./artifact-comment-access.server";
import type { ArtifactBlobStore } from "./artifact-files.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import type { CommentRow } from "./artifact-comment-view.server";
import type { CommentTx } from "./artifact-comment-write.server";

export type CommentImageBlobs = Pick<ArtifactBlobStore, "allowed" | "use" | "read"> &
  Pick<StoredArtifactBlobs, "upload">;

export type PreparedImage = {
  sha256: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
};

const refuse = (errorId: string, hint: string): never => {
  throw new AppError("INVALID_INPUT", { errorId, hint });
};

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

function contentTypeOf(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && ascii(bytes, 1, 4) === "PNG" && bytes[0] === 0x89) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return null;
}

const IMAGE_SIZE_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function check(sha256: string, bytes: Uint8Array) {
  if (bytes.length === 0) refuse("artifact-image-empty", `image ${sha256} has no bytes`);
  if (bytes.length > ARTIFACT_COMMENT_IMAGE_MAX_BYTES)
    refuse("artifact-image-too-large", "a comment image is at most 10 MiB");
  const contentType = contentTypeOf(bytes);
  if (!contentType)
    return refuse("artifact-image-type", "a comment image is a PNG, JPEG, WebP or GIF");
  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(Uint8Array.from(bytes));
  } catch {
    return refuse("artifact-image-type", "the image could not be read");
  }
  const { width, height } = size;
  if ((size.type ? IMAGE_SIZE_TYPE[size.type] : undefined) !== contentType || !width || !height)
    return refuse("artifact-image-type", "the image could not be read");
  if (width * height > ARTIFACT_COMMENT_IMAGE_MAX_PIXELS)
    refuse("artifact-image-pixels", "a comment image is at most 40 megapixels");
  return contentType;
}

const reencode = (image: Sharp, contentType: string) =>
  contentType === "image/png"
    ? image.png()
    : contentType === "image/jpeg"
      ? image.jpeg({ quality: 92 })
      : contentType === "image/gif"
        ? image.gif()
        : image.webp({ quality: 92 });

async function stripped(bytes: Uint8Array, contentType: string) {
  try {
    const input = sharp(Uint8Array.from(bytes), {
      animated: true,
      limitInputPixels: ARTIFACT_COMMENT_IMAGE_MAX_PIXELS,
    });
    const out = await reencode(input.rotate(), contentType).toBuffer();
    const meta = await sharp(out).metadata();
    const width = meta.width;
    const height = meta.pageHeight ?? meta.height;
    if (!width || !height) throw new Error("no size");
    return { out: new Uint8Array(out) as Uint8Array<ArrayBuffer>, width, height };
  } catch {
    return refuse("artifact-image-type", "the image could not be decoded");
  }
}

export async function prepareImages(
  blobs: CommentImageBlobs,
  principal: { workspaceId: string; agentId: string },
  shas: readonly string[],
): Promise<PreparedImage[]> {
  if (shas.length === 0) return [];
  const { workspaceId, agentId } = principal;
  const granted = await blobs.allowed(workspaceId, undefined, { agentId }, shas);
  const prepared: PreparedImage[] = [];
  for (const sha256 of shas) {
    const bytes = granted.has(sha256) ? await blobs.read(workspaceId, sha256) : null;
    if (!bytes)
      refuse(
        "artifact-image-not-found",
        `${sha256} is not one of your uploads: upload the image first`,
      );
    const contentType = check(sha256, bytes!);
    const clean = await stripped(bytes!, contentType);
    const stored = await blobs.upload({
      workspaceId,
      bytes: clean.out,
      actor: { agentId },
    });
    prepared.push({
      sha256: stored.sha256,
      contentType,
      sizeBytes: clean.out.length,
      width: clean.width,
      height: clean.height,
    });
  }
  return prepared;
}

export async function attachImages(
  tx: CommentTx,
  blobs: Pick<ArtifactBlobStore, "use">,
  input: {
    workspaceId: string;
    artifactId: string;
    rows: readonly CommentRow[];
    images: readonly (readonly PreparedImage[])[];
  },
): Promise<void> {
  const data = input.rows.flatMap((row, at) =>
    (input.images[at] ?? []).map((image, position) => ({
      artifactId: input.artifactId,
      commentId: row.id,
      position,
      ...image,
    })),
  );
  if (data.length === 0) return;
  const gone = await blobs.use(tx, input.workspaceId, [...new Set(data.map((row) => row.sha256))]);
  if (gone.length) refuse("artifact-image-not-found", "an uploaded image is gone: upload it again");
  await tx.artifactCommentImage.createMany({ data });
}

export async function readCommentImage(
  db: PrismaClient,
  blobs: Pick<ArtifactBlobStore, "read">,
  principal: { workspaceId: string; agentId: string },
  input: { artifact: string; image: string },
) {
  const { workspaceId, agentId } = principal;
  const artifact = await requireReadableArtifact(db, workspaceId, { agentId }, input.artifact);
  const image = await db.artifactCommentImage.findFirst({
    where: { id: input.image, artifactId: artifact.id, comment: { deletedAt: null } },
    select: {
      id: true,
      sha256: true,
      contentType: true,
      sizeBytes: true,
      width: true,
      height: true,
    },
  });
  const bytes = image ? await blobs.read(workspaceId, image.sha256) : null;
  if (!image || !bytes)
    throw new AppError("NOT_FOUND", {
      errorId: "artifact-image-not-found",
      hint: "this artifact has no such comment image: `coforge artifact comments` lists them",
    });
  const { sha256: _sha256, ...shown } = image;
  return { ...shown, data: Buffer.from(bytes).toString("base64") };
}
