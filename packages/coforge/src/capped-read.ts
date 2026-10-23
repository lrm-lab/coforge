/**
 * The text of a response or stream, or `null` when it is longer than `maxBytes`. A `Response` is
 * refused up front by `content-length` and its body released; every source is also counted while
 * streaming, so a missing or false length changes nothing. The stream is always cancelled.
 */
export async function readCappedText(
  source: Response | ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | null> {
  const stream = source instanceof Response ? source.body : source;
  if (source instanceof Response) {
    const declared = Number(source.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await stream?.cancel().catch(() => undefined);
      return null;
    }
  }
  const reader = stream?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) return null;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Cancelling also covers a read that threw or timed out; after a full read it is a no-op.
    await reader.cancel().catch(() => undefined);
  }
}
