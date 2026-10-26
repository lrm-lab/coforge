import { describe, expect, test } from "bun:test";

import {
  attachmentPreviewKind,
  isFrameableDocumentUrl,
  isTextContent,
} from "#src/features/conversations/attachment-preview-kind";

const APP_ORIGIN = "https://app.coforge.cn";
const DELIVERY_ORIGIN = "https://files.coforge.cn";

describe("a PDF is previewable only from a different origin", () => {
  // A PDF renders in the browser's own viewer, which an empty `sandbox` blocks outright, so the
  // origin boundary is the only isolation left: the document must load somewhere that holds none
  // of this application's cookies. Every way of failing that test must fall back to the download.
  test("a signed delivery URL on another origin is previewable", () => {
    expect(
      attachmentPreviewKind(
        "spec.pdf",
        "application/pdf",
        `${DELIVERY_ORIGIN}/o/k?sig=1`,
        APP_ORIGIN,
      ),
    ).toBe("pdf");
  });

  test("a URL on the application's own origin is refused", () => {
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", `${APP_ORIGIN}/o/k?sig=1`, APP_ORIGIN),
    ).toBeNull();
  });

  test("a relative or malformed URL is refused", () => {
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", "/api/attachments/abc", APP_ORIGIN),
    ).toBeNull();
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", "not a url", APP_ORIGIN),
    ).toBeNull();
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", "javascript:alert(1)", APP_ORIGIN),
    ).toBeNull();
  });

  test("no delivery URL at all is refused", () => {
    expect(attachmentPreviewKind("spec.pdf", "application/pdf", undefined, APP_ORIGIN)).toBeNull();
    expect(attachmentPreviewKind("spec.pdf", "application/pdf", "", APP_ORIGIN)).toBeNull();
  });

  test("the content type alone is enough to require the same check", () => {
    expect(attachmentPreviewKind("spec.bin", "application/pdf", undefined, APP_ORIGIN)).toBeNull();
    expect(
      attachmentPreviewKind("spec.bin", "application/pdf", `${DELIVERY_ORIGIN}/o/k`, APP_ORIGIN),
    ).toBe("pdf");
  });

  test("server rendering frames nothing: with no page origin, no URL is previewable", () => {
    // A frame emitted during SSR is decided by no origin check at all — the browser can start
    // loading its `src` from the served HTML before hydration re-runs the check and removes it,
    // which is not fail-closed. The hydrated browser always has an origin, so the PDF frame
    // appears there instead.
    expect(isFrameableDocumentUrl(`${DELIVERY_ORIGIN}/o/k`, undefined)).toBe(false);
    expect(isFrameableDocumentUrl(`${APP_ORIGIN}/o/k`, undefined)).toBe(false);
    expect(isFrameableDocumentUrl("/api/attachments/abc", undefined)).toBe(false);
    expect(isFrameableDocumentUrl(undefined, undefined)).toBe(false);
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", `${DELIVERY_ORIGIN}/o/k`, undefined),
    ).toBeNull();
  });

  test("a delivery origin equal to the application's own is never framed, however it is reached", () => {
    // The deployment the server-side guard cannot catch: `AUTHING_REDIRECT_URI` is unset, so
    // `readFileDeliveryConfig` has no application origin to compare and permits the delivery URL.
    // This is then the only check left, and it refuses.
    expect(isFrameableDocumentUrl(`${APP_ORIGIN}/files/o/k`, APP_ORIGIN)).toBe(false);
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", `${APP_ORIGIN}/files/o/k`, APP_ORIGIN),
    ).toBeNull();
  });
});

describe("the other kinds are decided by name, then by content type", () => {
  test("Markdown and HTML need no delivery URL", () => {
    expect(attachmentPreviewKind("notes.md", "text/plain", undefined, APP_ORIGIN)).toBe("markdown");
    expect(
      attachmentPreviewKind("page.htm", "application/octet-stream", undefined, APP_ORIGIN),
    ).toBe("html");
    expect(attachmentPreviewKind("notes", "text/markdown", undefined, APP_ORIGIN)).toBe("markdown");
  });

  test("plain text is previewable by extension or content type, never parsed as Markdown", () => {
    expect(attachmentPreviewKind("readme.txt", "text/plain", undefined, APP_ORIGIN)).toBe("text");
    // A CSV is a table even when it arrives as `text/plain`.
    expect(attachmentPreviewKind("data.csv", "text/plain", undefined, APP_ORIGIN)).toBe("csv");
    expect(attachmentPreviewKind("export", "text/csv", undefined, APP_ORIGIN)).toBe("csv");
    expect(
      attachmentPreviewKind("NOTES.txt", "application/octet-stream", undefined, APP_ORIGIN),
    ).toBe("text");
    // An unknown extension carrying `text/plain` is still previewed literally (a `.txt` routinely
    // arrives as `text/plain`; a generic plain-text file is the same safe reading).
    expect(attachmentPreviewKind("changelog", "text/plain", undefined, APP_ORIGIN)).toBe("text");
  });

  test("source code, configuration, data and logs read as plain text, so their lines take comments", () => {
    for (const name of ["app.ts", "main.py", "package.json", "ci.yml", "server.log", "fix.patch"])
      expect(attachmentPreviewKind(name, "application/octet-stream", undefined, APP_ORIGIN)).toBe(
        "text",
      );
    // A content type alone is enough for text: any `text/*` and the common structured types.
    expect(attachmentPreviewKind("Makefile", "text/x-makefile", undefined, APP_ORIGIN)).toBe(
      "text",
    );
    expect(attachmentPreviewKind("payload", "application/json", undefined, APP_ORIGIN)).toBe(
      "text",
    );
    // TypeScript routinely arrives as `video/mp2t`; the name still decides, the bytes are checked later.
    expect(attachmentPreviewKind("app.ts", "video/mp2t", undefined, APP_ORIGIN)).toBe("text");
    // HTML keeps its own preview however it is labelled.
    expect(attachmentPreviewKind("page", "text/html", undefined, APP_ORIGIN)).toBe("html");
  });

  test("allowlisted media is previewable, other files are not", () => {
    expect(attachmentPreviewKind("clip.mp4", "video/mp4", undefined, APP_ORIGIN)).toBe("video");
    expect(attachmentPreviewKind("voice.wav", "audio/wav", undefined, APP_ORIGIN)).toBe("audio");
    expect(
      attachmentPreviewKind("bundle.zip", "application/zip", undefined, APP_ORIGIN),
    ).toBeNull();
    expect(attachmentPreviewKind("logo.svg", "image/svg+xml", undefined, APP_ORIGIN)).toBeNull();
  });
});

describe("a file named as text previews only when its bytes are text", () => {
  const utf8 = (value: string) => new TextEncoder().encode(value);

  test("UTF-8 text passes, including a multi-byte character cut by the end of the checked head", () => {
    expect(isTextContent(utf8("export const answer = 42;\n"))).toBe(true);
    expect(isTextContent(new Uint8Array())).toBe(true);
    // "中" is three bytes and "🚀" four: the head ends two bytes into the first, one into the second.
    for (const [padding, character] of [
      [2, "中"],
      [1, "🚀"],
    ] as const) {
      const cut = new Uint8Array([
        ...new Uint8Array(8 * 1024 - padding).fill(0x61),
        ...utf8(character),
      ]);
      expect(isTextContent(cut)).toBe(true);
    }
  });

  test("a NUL or invalid UTF-8 in the head marks the file as binary", () => {
    // An MPEG transport stream: 188-byte packets opening with the 0x47 sync byte.
    const packet = new Uint8Array(188);
    packet.set([0x47, 0x40, 0x00, 0x10]);
    expect(isTextContent(packet)).toBe(false);
    expect(isTextContent(new Uint8Array([0x61, 0xff, 0x62]))).toBe(false);
  });

  test("bytes past the checked head do not count", () => {
    const tail = new Uint8Array([...new Uint8Array(8 * 1024).fill(0x61), 0xff, 0x00]);
    expect(isTextContent(tail)).toBe(true);
  });
});
