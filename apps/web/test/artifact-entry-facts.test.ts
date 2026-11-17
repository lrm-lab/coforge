import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { artifactEntryFacts } from "#src/server/artifacts/artifact-entry-facts.server";

const bytes = (text: string) => new TextEncoder().encode(text);
const facts = (path: string, content: Uint8Array) =>
  artifactEntryFacts(path, content.length, async () => content);

const plainPdf = (pages: number) =>
  bytes(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      `2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count ${pages} >> endobj`,
      `3 0 obj << /Type /Pages /Parent 2 0 R /Count 2 /Kids [] >> endobj`,
      "4 0 obj << /Type /Page /Parent 2 0 R >> endobj",
      "5 0 obj << /Type /Outlines /Count 99 >> endobj",
      "%%EOF",
    ].join("\n"),
  );

function compressedPdf(pages: number) {
  const objects = `<< /Type /Catalog /Pages 2 0 R >> << /Count ${pages} /Kids [] /Type /Pages >>`;
  const packed = deflateSync(bytes(objects));
  const head = bytes(
    `%PDF-1.7\n7 0 obj << /Type /ObjStm /N 2 /First 8 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
  );
  const tail = bytes("\nendstream\nendobj\n%%EOF");
  return new Uint8Array([...head, ...packed, ...tail]);
}

test("a PDF counts the pages of its page tree, also inside a compressed object stream", async () => {
  const plain = plainPdf(12);
  const packed = compressedPdf(37);
  expect(await facts("report.pdf", plain)).toEqual({ sizeBytes: plain.length, pages: 12 });
  expect(await facts("report.pdf", packed)).toEqual({ sizeBytes: packed.length, pages: 37 });
});

test("a PDF whose page tree cannot be read keeps only its size", async () => {
  expect(await facts("broken.pdf", bytes("%PDF-1.4 nothing here"))).toEqual({ sizeBytes: 21 });
});

test("a text file counts its lines, a final newline closing the last one", async () => {
  expect(await facts("notes.txt", bytes("one\ntwo\r\nthree\n"))).toEqual({
    sizeBytes: 15,
    lines: 3,
  });
  expect(await facts("data.json", bytes("{}"))).toEqual({ sizeBytes: 2, lines: 1 });
  expect(await facts("empty.txt", bytes(""))).toEqual({ sizeBytes: 0, lines: 0 });
});

test("a CSV counts its rows under the header and names the header's columns", async () => {
  const csv = bytes('name,region, total \n"Ada, L.",north,3\n"two\nlines",south,4\n');
  expect(await facts("sales.csv", csv)).toEqual({
    sizeBytes: csv.length,
    rows: 2,
    columns: 3,
    columnNames: ["name", "region", "total"],
  });
  const wide = bytes(`${Array.from({ length: 30 }, (_, i) => `c${i}`).join(",")}\n`);
  expect((await facts("wide.csv", wide))?.columnNames).toHaveLength(20);
});

test("an image reads its pixels from the header; another file keeps only its size", async () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 7,
    0x80, 0, 0, 4, 0x38, 8, 2, 0, 0, 0,
  ]);
  expect(await facts("shot.png", png)).toEqual({
    sizeBytes: png.length,
    width: 1920,
    height: 1080,
  });
  expect(await facts("clip.mp4", new Uint8Array(4096))).toEqual({ sizeBytes: 4096 });
});

test("Markdown and HTML entries have no facts; a file past the read limit keeps its size unread", async () => {
  expect(await facts("README.md", bytes("# Hi"))).toBeNull();
  expect(await facts("index.html", bytes("<p>"))).toBeNull();
  let read = false;
  expect(
    await artifactEntryFacts("huge.pdf", 50 * 1024 * 1024, async () => {
      read = true;
      return null;
    }),
  ).toEqual({ sizeBytes: 50 * 1024 * 1024 });
  expect(read).toBe(false);
});

test("a hostile PDF near the read limit keeps only its size, quickly", async () => {
  const limit = 2 * 1024 * 1024 - 1024;
  const zeros = deflateSync(new Uint8Array(8 * 1024 * 1024));
  const stream = new Uint8Array([
    ...bytes(`<< /Type /ObjStm /Filter /FlateDecode /Length ${zeros.length} >>\nstream\n`),
    ...zeros,
    ...bytes("\nendstream\n"),
  ]);
  const bomb = new Uint8Array(Math.floor(limit / stream.length) * stream.length);
  for (let at = 0; at < bomb.length; at += stream.length) bomb.set(stream, at);
  const started = performance.now();
  for (const hostile of [
    bytes("/Type/Pages /Count 1 ".repeat(limit / 21)),
    bytes(">> stream\n".repeat(limit / 10)),
    bytes("<<".repeat(limit / 2)),
    bytes("(".repeat(limit)),
    bytes("<< /Type/Pages ".repeat(limit / 15)),
    bytes(">> /Type/Pages ".repeat(limit / 15)),
    bytes("<< /Type /Pages /Count 99999999999999999999999 >>"),
    bomb,
  ])
    expect(await facts("hostile.pdf", hostile)).toEqual({ sizeBytes: hostile.length });
  expect(performance.now() - started).toBeLessThan(2000);
});
