import { describe, expect, test } from "bun:test";
import { storedAttachmentContentType } from "#src/lib/inline-image";

describe("storedAttachmentContentType", () => {
  test("a file named .svg with no declared type is stored as SVG", () => {
    expect(storedAttachmentContentType("logo.svg", "")).toBe("image/svg+xml");
    expect(storedAttachmentContentType("logo.svg", undefined)).toBe("image/svg+xml");
    expect(storedAttachmentContentType("Logo.SVG", "image/svg+xml")).toBe("image/svg+xml");
  });

  test("an untyped .svg is stored as SVG, whatever the case of its name", () => {
    expect(storedAttachmentContentType("logo.Svg", "application/octet-stream")).toBe(
      "image/svg+xml",
    );
    expect(storedAttachmentContentType("  logo.svg  ", "")).toBe("image/svg+xml");
  });

  test("a type the uploader declared is kept", () => {
    expect(storedAttachmentContentType("logo.svg", "text/plain")).toBe("text/plain");
    expect(storedAttachmentContentType("photo.png", "image/png")).toBe("image/png");
    expect(storedAttachmentContentType("report.pdf", "application/pdf")).toBe("application/pdf");
  });

  test("anything else keeps the untyped default", () => {
    expect(storedAttachmentContentType("photo.png", "")).toBe("application/octet-stream");
    expect(storedAttachmentContentType("notes.svgh", "")).toBe("application/octet-stream");
    expect(storedAttachmentContentType("logo.svg.txt", "")).toBe("application/octet-stream");
    expect(storedAttachmentContentType("attachment", undefined)).toBe("application/octet-stream");
  });
});
