import {
  attachmentPreviewKind,
  isTextPreviewKind,
} from "#src/features/conversations/attachment-preview-kind";
import { PRIVATE_NO_STORE } from "#src/server/http/cache-control.server";
import type { StoredFile } from "#src/server/files/file-storage.server";

/** Image types the browser may render inline from `/api/attachments/:id`. Everything else is
 * delivered as an opaque download so a stored HTML/SVG/PDF can never execute in the app origin. */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Whether `contentType` is one of the raster image types the browser may render inline. */
export function isInlineImage(contentType: string): boolean {
  return INLINE_IMAGE_TYPES.has(contentType);
}

/**
 * Types the browser may render, but only from the signed delivery (CDN) origin — never from this
 * one. A PDF is read in the browser's own viewer, which needs a real URL with a real content type;
 * serving that from our origin would put a document the sender controls inside our session's
 * origin, which is exactly what `INLINE_IMAGE_TYPES` exists to prevent. On the delivery origin it
 * has no access to our cookies, so the viewer is safe there. Where delivery is not configured
 * there is no such URL, and the attachment stays an opaque download (`attachmentResponseHeaders`
 * is deliberately not widened).
 */
const DELIVERY_INLINE_TYPES = new Set(["application/pdf"]);

/** Whether `contentType` may be previewed, but only through a signed delivery URL. */
export function isDeliveryInlinePreview(contentType: string): boolean {
  return DELIVERY_INLINE_TYPES.has(contentType);
}

/**
 * Response headers for one authorized attachment. `forceDownload` (the `?download` query)
 * always yields `Content-Disposition: attachment`; otherwise safe raster images are served with
 * their real content type and `inline` so `<img src>` works, and the rest stay octet-stream.
 */
export function attachmentResponseHeaders(
  attachment: { fileName: string; contentType: string },
  forceDownload: boolean,
): Record<string, string> {
  const inline = !forceDownload && isInlineImage(attachment.contentType);
  const fileName = attachment.fileName.replace(/["\\\r\n]/g, "_");
  return {
    "Content-Type": inline ? attachment.contentType : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fileName}"`,
    "X-Content-Type-Options": "nosniff",
    "cache-control": PRIVATE_NO_STORE,
  };
}

/** Whether `Accept-Encoding` takes gzip: named (`gzip`, `x-gzip`, or `*`) without `q=0`. */
export function acceptsGzip(header: string | null): boolean {
  let wildcard = false;
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [coding = "", ...params] = part.split(";").map((value) => value.trim());
    const refused = params.some((param) => /^q=0(?:\.0*)?$/.test(param));
    if (coding === "gzip" || coding === "x-gzip") return !refused;
    if (coding === "*") wildcard = !refused;
  }
  return wildcard;
}

/**
 * One authorized attachment's bytes as a response. A file the preview reads as text (Markdown,
 * CSV, code, logs) is gzipped for a browser that accepts it: these stream through the backend as
 * `application/octet-stream`, which Caddy's `encode` leaves alone, and a multi-megabyte text file
 * then crossed the network at full size (task #242). The content type stays octet-stream, so the
 * file still never renders on this origin; the browser undoes the encoding before anyone reads the
 * bytes, so the preview's size limit counts the file's own bytes. Other types are already
 * compressed (images, archives, media) or rare, and pass through as stored.
 */
export function attachmentResponse(
  request: Request,
  attachment: { fileName: string; contentType: string },
  file: StoredFile,
  forceDownload: boolean,
): Response {
  const headers = attachmentResponseHeaders(attachment, forceDownload);
  if (!isTextPreviewKind(attachmentPreviewKind(attachment.fileName, attachment.contentType)))
    return new Response(file.body, { headers });
  headers.Vary = "Accept-Encoding";
  if (!acceptsGzip(request.headers.get("accept-encoding")))
    return new Response(file.body, { headers });
  const body = new Response(file.body).body!;
  return new Response(body.pipeThrough(new CompressionStream("gzip")), {
    headers: { ...headers, "Content-Encoding": "gzip" },
  });
}
