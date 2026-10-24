import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentMimeType,
  inferAttachmentMimeType,
  sniffImageMimeType,
} from "#src/attachment-upload";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0];
const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
const WEBP = [...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")];

test("recognises PNG, JPEG, GIF87a, GIF89a and WebP by their leading bytes", () => {
  expect(sniffImageMimeType(Uint8Array.from(PNG))).toBe("image/png");
  expect(sniffImageMimeType(Uint8Array.from(JPEG))).toBe("image/jpeg");
  expect(sniffImageMimeType(Uint8Array.from(ascii("GIF87a")))).toBe("image/gif");
  expect(sniffImageMimeType(Uint8Array.from(ascii("GIF89a")))).toBe("image/gif");
  expect(sniffImageMimeType(Uint8Array.from(WEBP))).toBe("image/webp");
});

test("anything else, or a header cut short, is not an image", () => {
  expect(sniffImageMimeType(Uint8Array.from(ascii("hello world")))).toBeUndefined();
  expect(sniffImageMimeType(Uint8Array.from(PNG.slice(0, 7)))).toBeUndefined();
  expect(sniffImageMimeType(Uint8Array.from(ascii("RIFF....WAVE")))).toBeUndefined();
  expect(sniffImageMimeType(new Uint8Array())).toBeUndefined();
});

test("the leading bytes beat the extension, and the extension still decides when they say nothing", () => {
  expect(attachmentMimeType("photo.png", undefined, Uint8Array.from(JPEG))).toBe("image/jpeg");
  expect(attachmentMimeType("notes.md", undefined, Uint8Array.from(ascii("# hi")))).toBe(
    "text/markdown",
  );
  expect(attachmentMimeType("blob", undefined, Uint8Array.from(PNG))).toBe("image/png");
  expect(attachmentMimeType("photo.png", "image/x-custom", Uint8Array.from(JPEG))).toBe(
    "image/x-custom",
  );
});

test("reads the file itself: a JPEG named .png uploads as image/jpeg unless --mime-type says otherwise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-mime-sniff-"));
  try {
    const path = join(directory, "photo.png");
    await writeFile(path, Uint8Array.from([...JPEG, ...Array.from({ length: 64 }, () => 7)]));
    expect(await inferAttachmentMimeType(path)).toBe("image/jpeg");
    expect(await inferAttachmentMimeType(path, "image/png")).toBe("image/png");
    const text = join(directory, "readme.txt");
    await writeFile(text, "plain");
    expect(await inferAttachmentMimeType(text)).toBe("text/plain");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
