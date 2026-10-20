import { AppError } from "#src/lib/app-error";
import {
  IMAGE_MAX_BYTES,
  IMAGE_UPLOAD_TYPES,
  type APP_LOGO_UPLOAD_TYPES,
} from "#src/lib/image-upload";

export { IMAGE_MAX_BYTES };

type ImageType = (typeof APP_LOGO_UPLOAD_TYPES)[number];

/** The bytes each type starts with; any one of a type's signatures will do. */
const CONTENT_SIGNATURES: Record<ImageType, readonly (readonly number[])[]> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
  // GIF87a, GIF89a.
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
};

/**
 * Refuses (INVALID_INPUT) an upload that is empty, over `IMAGE_MAX_BYTES`, not one of `types`, or
 * whose first bytes are not that type's. Avatars and icons take the default types; an app logo
 * also takes a GIF (`APP_LOGO_UPLOAD_TYPES`).
 */
export async function validateImage(file: File, types: readonly ImageType[] = IMAGE_UPLOAD_TYPES) {
  const type = types.find((candidate) => candidate === file.type);
  if (!type || file.size === 0 || file.size > IMAGE_MAX_BYTES) throw new AppError("INVALID_INPUT");
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = CONTENT_SIGNATURES[type].some((signature) =>
    signature.every((byte, index) => bytes[index] === byte),
  );
  const webpMatches =
    type !== "image/webp" || String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!matches || !webpMatches) throw new AppError("INVALID_INPUT");
}
