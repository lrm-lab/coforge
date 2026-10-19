import { describe, expect, test } from "bun:test";

import { fileIconType } from "#src/features/files/file-icon-type";

describe("a file with a glyph of its own is drawn with it", () => {
  test("the extension names the glyph, whatever its case or directory", () => {
    expect(fileIconType("andong3-shot.png")).toBe("png");
    expect(fileIconType("REPORT.PDF")).toBe("pdf");
    expect(fileIconType("src/data/config.json")).toBe("json");
    expect(fileIconType("notes.txt")).toBe("txt");
    expect(fileIconType("budget.xlsx")).toBe("xlsx");
  });

  test("a category glyph's name is not an extension", () => {
    // `folder` is a glyph, but a file ending in `.folder` is still a file of unknown kind.
    expect(fileIconType("archive.folder")).toBe("empty");
  });
});

describe("any other file is drawn by its kind", () => {
  test("Markdown is a document, not code", () => {
    expect(fileIconType("MEMORY.md")).toBe("document");
  });

  test("source files are code, including extension-less build files", () => {
    expect(fileIconType("index.ts")).toBe("code");
    expect(fileIconType("Dockerfile")).toBe("code");
  });

  test("an office file without its own glyph is a document or a spreadsheet", () => {
    expect(fileIconType("deck.key")).toBe("document");
    expect(fileIconType("letter.odt")).toBe("document");
    expect(fileIconType("table.ods")).toBe("spreadsheets");
  });

  test("audio without its own glyph is audio", () => {
    expect(fileIconType("memo.m4a")).toBe("audio");
  });

  test("the media type classifies a file whose extension has no glyph", () => {
    expect(fileIconType("photo.heic", "image/heic")).toBe("image");
    expect(fileIconType("clip.unknownext", "video/x-foo")).toBe("video");
  });

  test("an archive, a dotfile, or a file of unknown kind is the empty glyph", () => {
    expect(fileIconType("backup.tar.gz")).toBe("empty");
    expect(fileIconType(".env")).toBe("empty");
    expect(fileIconType("LICENSE")).toBe("empty");
    expect(fileIconType("notes.final version")).toBe("empty");
    expect(fileIconType("data.qqq")).toBe("empty");
  });
});
