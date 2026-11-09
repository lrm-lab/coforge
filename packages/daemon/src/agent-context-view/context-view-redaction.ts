import { createHash } from "node:crypto";

export type ContextViewRedactionCounts = { media: number; diagnostic: number };

const DATA_URL = /^data:([^;,]{1,100});base64,([A-Za-z0-9+/=_-]+)$/;
const INLINE_MEDIA_MIN_CHARS = 1024;
const DIAGNOSTIC_URL =
  /https?:\/\/[^\s"']+(?:token|api[_-]?key|access[_-]?token|secret|signature|auth)[^\s"']*/gi;

function mediaMarker(mediaType: string | null, bytes: number, value: Uint8Array): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `[raft:media ${mediaType ?? "unknown"} ${bytes} bytes sha256=${hash}]`;
}

function redactDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.search) url.search = "?[REDACTED_QUERY]";
    if (url.username) url.username = "[REDACTED_USER]";
    if (url.password) url.password = "[REDACTED_PASSWORD]";
    return url.toString();
  } catch {
    return value.replace(/\?.*$/, "?[REDACTED_QUERY]");
  }
}

export function redactContextViewValue(
  value: unknown,
  counts: ContextViewRedactionCounts,
): unknown {
  if (value instanceof Uint8Array) {
    counts.media += 1;
    return mediaMarker(null, value.byteLength, value);
  }
  if (typeof value === "string") {
    const data = DATA_URL.exec(value);
    if (data && value.length >= INLINE_MEDIA_MIN_CHARS) {
      counts.media += 1;
      const payload = Buffer.from(data[2] ?? "", "base64");
      return mediaMarker(data[1] ?? null, payload.byteLength, payload);
    }
    const replaced = value.replace(DIAGNOSTIC_URL, (url) => {
      const redacted = redactDiagnosticUrl(url);
      if (redacted !== url) counts.diagnostic += 1;
      return redacted;
    });
    return replaced;
  }
  if (Array.isArray(value)) return value.map((item) => redactContextViewValue(item, counts));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const mediaType =
      typeof object.media_type === "string"
        ? object.media_type
        : typeof object.mimeType === "string"
          ? object.mimeType
          : null;
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => {
        if (
          key === "data" &&
          typeof item === "string" &&
          /^[A-Za-z0-9+/=_-]+$/.test(item) &&
          item.length >= 1024 &&
          mediaType
        ) {
          const payload = Buffer.from(item, "base64");
          counts.media += 1;
          return [key, mediaMarker(mediaType, payload.byteLength, payload)];
        }
        return [key, redactContextViewValue(item, counts)];
      }),
    );
  }
  return value;
}
