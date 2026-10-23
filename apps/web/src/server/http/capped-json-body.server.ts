const encoder = new TextEncoder();

/**
 * A request's JSON body within `maxBytes` of UTF-8: a declared `content-length` that is malformed
 * or over the cap is refused before the body is read, and the body read is measured again (a
 * caller can omit or lie about the header). Answers the parsed value, or why there is none.
 */
export async function readCappedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too_large" | "not_json" }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
    return { ok: false, reason: "too_large" };
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > maxBytes) return { ok: false, reason: "too_large" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "not_json" };
  }
}
