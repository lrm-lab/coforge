import {
  FILE_ROW_IMAGE_PX,
  MESSAGE_IMAGE_MAX_HEIGHT_PX,
  MESSAGE_IMAGE_MAX_WIDTH_PX,
} from "#src/lib/attachment-image-box";

/** Twice each box, for 2x screens. */
const SCALE = 2;
/** The lightbox's long side: a phone photo opens in a few hundred KB, not its 5-10 MB. */
const LARGE_LONG_SIDE_PX = 2048;

/**
 * Types OSS resizes and turns into WebP. HEIC/HEIF (iPhone photos) are here too: browsers cannot
 * show them, their WebP they can. A GIF keeps its original (resizing keeps one frame); an SVG is
 * never shown inline.
 */
const RESIZABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export function isResizableImage(contentType: string): boolean {
  return RESIZABLE_IMAGE_TYPES.has(contentType);
}

/**
 * One OSS image process, in a fixed order: the CDN keys its cache on the query as written, so the
 * same picture in the same tier is always the same URL. Upright from the photo's orientation,
 * resized within the box (`m_lfit`) or cropped to fill it (`m_fill`), never enlarged, as WebP.
 */
function process(mode: "m_lfit" | "m_fill", width: number, height: number, quality: number) {
  return `image/auto-orient,1/resize,${mode},w_${width},h_${height},limit_1/format,webp/quality,q_${quality}`;
}

const TIERS = {
  /** A message: within twice a lone image's 416×288 box; a grid cell is smaller still. */
  thumbnailUrl: process(
    "m_lfit",
    MESSAGE_IMAGE_MAX_WIDTH_PX * SCALE,
    MESSAGE_IMAGE_MAX_HEIGHT_PX * SCALE,
    80,
  ),
  /** A Files row: its 40px square is `object-cover`, so the variant fills it. */
  iconUrl: process("m_fill", FILE_ROW_IMAGE_PX * SCALE, FILE_ROW_IMAGE_PX * SCALE, 80),
  /** The lightbox; Download still gives the original. */
  largeUrl: process("m_lfit", LARGE_LONG_SIDE_PX, LARGE_LONG_SIDE_PX, 85),
} as const;

export type ImageVariants = { [Tier in keyof typeof TIERS]: string };

/**
 * The resized variants of a signed attachment URL: the same object and signature, plus OSS's
 * `x-oss-process`, which the CDN passes back to the origin and keeps as its own cache entry (Type A
 * signing covers the path only).
 */
export function imageVariants(signedUrl: string): ImageVariants {
  // A Type A signed URL always carries its `auth_key` query already.
  const at = (operation: string) => `${signedUrl}&x-oss-process=${operation}`;
  return {
    thumbnailUrl: at(TIERS.thumbnailUrl),
    iconUrl: at(TIERS.iconUrl),
    largeUrl: at(TIERS.largeUrl),
  };
}
