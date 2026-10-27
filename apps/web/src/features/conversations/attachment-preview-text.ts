import { previewText } from "./attachment-preview-kind";

/** What reading a text preview found: its text, a file past the limit, or nothing to show. */
export type PreviewRead = { text: string } | "too-large" | "unavailable";

/**
 * Reads a text attachment for its preview through the authenticated route, as Raft does before it
 * opens one: a declared length past `maxBytes` stops before reading, and the stream is cancelled as
 * soon as it passes the limit (`"too-large"`). `"unavailable"` when the file has no text to show
 * (not UTF-8 text, blank, or the request failed); an abort through `signal` rejects instead.
 */
export async function readPreviewText(
  href: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<PreviewRead> {
  try {
    const response = await fetch(href, { signal });
    if (!response.ok || !response.body) return "unavailable";
    if (Number(response.headers.get("content-length")) > maxBytes) {
      void response.body.cancel();
      return "too-large";
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel();
        return "too-large";
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = previewText(bytes);
    return text === null ? "unavailable" : { text };
  } catch (error) {
    if (signal.aborted) throw error;
    return "unavailable";
  }
}
