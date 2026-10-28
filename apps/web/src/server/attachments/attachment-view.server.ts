import { getFileDelivery, type FileDelivery } from "#src/server/files/file-delivery.server";
import { isDeliveryInlinePreview, isInlineImage } from "./attachment-response.server";
import { imageVariants, isResizableImage } from "./attachment-image-variants.server";
import { errorType } from "#src/server/errors/error-type.server";
import type { Prisma } from "#src/generated/prisma/client";

export const ATTACHMENT_VIEW_SELECT = {
  id: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  objectKey: true,
  imageWidth: true,
  imageHeight: true,
} satisfies Prisma.AttachmentSelect;

export type AttachmentViewRow = Prisma.AttachmentGetPayload<{
  select: typeof ATTACHMENT_VIEW_SELECT;
}>;

export type AttachmentView = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Intrinsic display size; both are absent until a safe inline image has a known size. */
  imageWidth?: number;
  imageHeight?: number;
  /** A short-lived signed CDN URL, present for an inline-eligible image and for a file that may
   * only be previewed off our own origin (a PDF, a video) when delivery is configured. `<img src>` should
   * prefer this over `/api/attachments/:id` so the bytes never round-trip through the backend;
   * once it expires, that route is the fallback (it redirects to a freshly signed URL, or streams
   * the bytes when delivery is not configured). Its absence is also the client's signal that a
   * PDF cannot be previewed in this deployment, so it offers the download instead. */
  previewUrl?: string;
  /** The resized WebP variants of an image OSS can resize (`imageVariants`), on the same
   * signature: a message shows `thumbnailUrl`, a Files row `iconUrl`, the lightbox `largeUrl`;
   * Download keeps the original. A GIF has none (resizing keeps one frame). A HEIC has these and
   * no `previewUrl`: a browser cannot show its original. */
  thumbnailUrl?: string;
  iconUrl?: string;
  largeUrl?: string;
};

/** A signing failure must never take a message read down: the client falls back to the
 * authenticated route, which streams the bytes. Logged once per process without the key. */
function signPreviewUrl(delivery: FileDelivery, objectKey: string): string | undefined {
  try {
    return delivery.signedUrl(objectKey).url;
  } catch (error) {
    if (!signingFailureLogged) {
      signingFailureLogged = true;
      console.error(
        JSON.stringify({
          event: "file_delivery_signing_failed",
          errorType: errorType(error),
        }),
      );
    }
    return undefined;
  }
}

let signingFailureLogged = false;

/**
 * The browser-facing shape of one attachment, attached to every browser message payload — page
 * reads, polled updates, and the immediate response to the sender's own send — so `<img src>`
 * can be pointed straight at the CDN (Discord-style) instead of the backend proxy. `objectKey`
 * exists on the input only so this function can sign a delivery URL with it; it is never part of
 * the returned view and must never reach the client, logs, or analytics.
 */
export function attachmentView(
  row: AttachmentViewRow,
  delivery: FileDelivery | null = getFileDelivery(),
): AttachmentView {
  const { imageWidth, imageHeight } = row;
  const inlineImage = isInlineImage(row.contentType);
  const resizable = isResizableImage(row.contentType);
  const signed =
    delivery && (inlineImage || resizable || isDeliveryInlinePreview(row))
      ? signPreviewUrl(delivery, row.objectKey)
      : undefined;
  const previewUrl = signed && (inlineImage || !resizable) ? signed : undefined;
  return {
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    ...(inlineImage &&
    imageWidth !== null &&
    imageHeight !== null &&
    Number.isInteger(imageWidth) &&
    Number.isInteger(imageHeight) &&
    imageWidth > 0 &&
    imageHeight > 0
      ? { imageWidth, imageHeight }
      : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(signed && resizable ? imageVariants(signed) : {}),
  };
}
