import { utf8Encoder } from "@lrm/coforge-sdk/internal";

/** The default size limit of a request body the proxy reads. */
export const MAX_BODY_BYTES = 64 * 1024;

export const badRequest = () => new Response("bad request", { status: 400 });
export const payloadTooLarge = () => new Response("payload too large", { status: 413 });

/** A declared `content-length` that is malformed or over `maxBytes` (or absent, when required). */
export function contentLengthRejected(
  request: Request,
  maxBytes: number,
  required: boolean,
): boolean {
  const contentLength = request.headers.get("content-length");
  if (!contentLength) return required;
  return !/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes;
}

/**
 * The shared size-limited JSON body read: an oversized or malformed `content-length` is `413` up
 * front; otherwise the body is read and re-measured (a caller can omit or lie about
 * `content-length`), and malformed JSON is a `400` — this is the one place a `SyntaxError` becomes
 * a bare `400`; one thrown later, by a route's `parse` or by the runtime, is classified.
 */
export async function readJsonBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ payload: unknown } | Response> {
  if (contentLengthRejected(request, maxBytes, false)) return payloadTooLarge();
  const raw = await request.text();
  if (utf8Encoder.encode(raw).byteLength > maxBytes) return payloadTooLarge();
  try {
    return { payload: JSON.parse(raw) };
  } catch {
    return badRequest();
  }
}
