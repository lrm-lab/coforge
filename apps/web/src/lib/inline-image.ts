/**
 * Image types the browser may render inline from `/api/attachments/:id`.
 * Everything else (including `image/svg+xml`) is never served inline from the
 * app's own origin so a stored HTML/SVG/PDF can never execute scripts there.
 */
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const SVG_IMAGE_TYPE = "image/svg+xml";

/** Whether `contentType` is one of the raster image types the browser may render inline. */
export function isInlineImage(contentType: string): boolean {
  return INLINE_IMAGE_TYPES.has(contentType);
}

/** Whether `contentType` is SVG (`image/svg+xml`). */
export function isSvgImage(contentType: string): boolean {
  return contentType === SVG_IMAGE_TYPE;
}

const OCTET_STREAM_TYPE = "application/octet-stream";

export function storedAttachmentContentType(
  fileName: string,
  declaredType: string | undefined,
): string {
  const declared = (declaredType ?? "").trim();
  if (declared && declared !== OCTET_STREAM_TYPE) return declared;
  if (/\.svg$/i.test(fileName.trim())) return SVG_IMAGE_TYPE;
  return declared || OCTET_STREAM_TYPE;
}

/** Photos the server turns into WebP variants, since browsers other than Safari cannot draw them. */
const CONVERTED_IMAGE_TYPES = new Set(["image/heic", "image/heif"]);

/**
 * Whether the product shows files of `contentType` as images at all: the raster types, the photos
 * it converts, and SVG from the signed delivery. A rule by type alone, for places that hold no
 * delivery URLs (the server deciding comments, the composer before upload).
 */
export function isImageType(contentType: string): boolean {
  return (
    isInlineImage(contentType) || CONVERTED_IMAGE_TYPES.has(contentType) || isSvgImage(contentType)
  );
}

/**
 * Whether an attachment can be rendered as an image in the UI:
 * - inline-safe raster images (`png`, `jpeg`, `gif`, `webp`),
 * - server-converted WebP variants (`thumbnailUrl` / `largeUrl` / `iconUrl`, e.g. HEIC/HEIF), or
 * - SVG (`image/svg+xml`) only when it has a signed CDN `previewUrl` (never from `/api/attachments/:id`).
 */
export function isDisplayableImageAttachment(attachment: {
  contentType: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  largeUrl?: string;
  iconUrl?: string;
}): boolean {
  if (isInlineImage(attachment.contentType)) return true;
  if (
    attachment.thumbnailUrl !== undefined ||
    attachment.largeUrl !== undefined ||
    attachment.iconUrl !== undefined
  ) {
    return true;
  }
  return isSvgImage(attachment.contentType) && attachment.previewUrl !== undefined;
}
