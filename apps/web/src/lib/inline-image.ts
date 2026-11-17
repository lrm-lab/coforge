/** Image types the browser may render inline from `/api/attachments/:id`. Everything else is
 * delivered as an opaque download so a stored HTML/SVG/PDF can never execute in the app origin. */
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Whether `contentType` is one of the raster image types the browser may render inline. */
export function isInlineImage(contentType: string): boolean {
  return INLINE_IMAGE_TYPES.has(contentType);
}
