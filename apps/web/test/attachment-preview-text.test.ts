import { afterEach, expect, test } from "bun:test";

import { readPreviewText } from "#src/features/conversations/attachment-preview-text";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serves `body` in chunks of `chunk` bytes, with or without its length declared. */
function serve(body: Uint8Array, { chunk = 4, declareLength = true, status = 200 } = {}) {
  globalThis.fetch = (async () => {
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.byteLength) return controller.close();
        controller.enqueue(body.slice(offset, offset + chunk));
        offset += chunk;
      },
    });
    const headers = declareLength ? { "content-length": String(body.byteLength) } : undefined;
    return new Response(stream, { status, headers });
  }) as unknown as typeof fetch;
}

const utf8 = (value: string) => new TextEncoder().encode(value);
const read = (maxBytes: number) =>
  readPreviewText("/api/attachments/a", maxBytes, new AbortController().signal);

test("a file within the limit is read as its text", async () => {
  serve(utf8("# Report\n\nBody"));
  expect(await read(64)).toEqual({ text: "# Report\n\nBody" });
});

test("a file past the limit is too large, whether it says so up front or turns out so", async () => {
  serve(utf8("x".repeat(65)));
  expect(await read(64)).toBe("too-large");
  serve(utf8("x".repeat(65)), { declareLength: false });
  expect(await read(64)).toBe("too-large");
});

test("a file with no text to show, or a failed request, is unavailable", async () => {
  serve(new Uint8Array([0x47, 0xff, 0xfe, 0x00]));
  expect(await read(64)).toBe("unavailable");
  serve(utf8(" \n\t "));
  expect(await read(64)).toBe("unavailable");
  serve(utf8("gone"), { status: 404 });
  expect(await read(64)).toBe("unavailable");
});
