import { afterAll, expect, test } from "bun:test";

import { readPreviewText } from "#src/features/conversations/attachment-preview-text";
import { handleAttachmentDownload } from "#src/routes/api/attachments.$attachmentId";

/** One stored attachment, served by the real route with storage and auth faked. */
function download(
  attachment: { fileName: string; contentType: string },
  bytes: string,
  init: { acceptEncoding?: string; query?: string } = {},
) {
  return handleAttachmentDownload(
    new Request(
      `https://coforge.test/api/attachments/a1${init.query ?? ""}`,
      init.acceptEncoding ? { headers: { "accept-encoding": init.acceptEncoding } } : undefined,
    ),
    { attachmentId: "a1" },
    {
      authenticate: () => ({ id: "user-1" }),
      database: () => ({}) as never,
      read: async () => ({
        attachment: { ...attachment, objectKey: "k" },
        open: async () => ({ body: new Blob([bytes]), contentType: null, sizeBytes: bytes.length }),
      }),
      delivery: () => null,
    },
  );
}

const markdown = { fileName: "notes.md", contentType: "text/markdown" };
const gunzip = async (response: Response) =>
  new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())));

test("a text attachment is gzipped for a browser that accepts gzip, and stays octet-stream", async () => {
  const text = "# Notes\n\n" + "a line of prose\n".repeat(1000);
  const response = await download(markdown, text, { acceptEncoding: "gzip, deflate, br, zstd" });
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("vary")).toBe("Accept-Encoding");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await gunzip(response)).toBe(text);
});

test("a forced download of a text attachment is gzipped too", async () => {
  const response = await download(markdown, "# Notes", {
    acceptEncoding: "gzip",
    query: "?download",
  });
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="notes.md"');
  expect(await gunzip(response)).toBe("# Notes");
});

test("a text attachment is sent as stored when gzip is not accepted, and says it varies", async () => {
  for (const acceptEncoding of [undefined, "br", "identity", "gzip;q=0", "x-gzip;q=0, br"]) {
    const response = await download(markdown, "# Notes", { acceptEncoding });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(await response.text()).toBe("# Notes");
  }
});

test("a file the preview does not read as text is never gzipped", async () => {
  for (const attachment of [
    { fileName: "clip.zip", contentType: "application/zip" },
    { fileName: "shot.png", contentType: "image/png" },
  ]) {
    const response = await download(attachment, "bytes", {
      acceptEncoding: "gzip",
      query: "?download",
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    expect(await response.text()).toBe("bytes");
  }
});

/** The route behind a real HTTP server, so `fetch` negotiates and decodes gzip as a browser does. */
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    const size = Number(new URL(request.url).searchParams.get("size"));
    return handleAttachmentDownload(
      request,
      { attachmentId: "a1" },
      {
        authenticate: () => ({ id: "user-1" }),
        database: () => ({}) as never,
        read: async () => ({
          attachment: { ...markdown, objectKey: "k" },
          open: async () => ({
            body: new Blob(["x".repeat(size)]),
            contentType: null,
            sizeBytes: size,
          }),
        }),
        delivery: () => null,
      },
    );
  },
});
afterAll(() => server.stop(true));

test("the preview limit counts the file's own bytes, not the gzipped ones on the wire", async () => {
  const read = (size: number) =>
    readPreviewText(
      `${server.url}api/attachments/a1?size=${size}`,
      1000,
      new AbortController().signal,
    );
  // Each file gzips to a few dozen bytes, far under the limit either way.
  expect(await read(1000)).toEqual({ text: "x".repeat(1000) });
  expect(await read(1001)).toBe("too-large");
  expect(await read(100_000)).toBe("too-large");
});
