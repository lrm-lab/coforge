import { describe, expect, test } from "bun:test";

import {
  dragCarriesFiles,
  filesFromDrop,
  filesFromPaste,
  IME_ENTER_GUARD_MS,
  shouldSendOnEnter,
} from "#src/features/conversations/composer-behavior";
import { localId } from "#src/features/conversations/composer-behavior";
import { INLINE_IMAGE_TYPES, imageUrlsFromPaste } from "#src/features/conversations/paste-image";

const baseEnter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
const noComposition = { lastCompositionEndAt: null, now: 0 };

describe("shouldSendOnEnter", () => {
  test("sends on plain Enter outside composition", () => {
    expect(shouldSendOnEnter(baseEnter, noComposition)).toBe(true);
  });

  test("keeps Shift+Enter as a newline", () => {
    expect(shouldSendOnEnter({ ...baseEnter, shiftKey: true }, noComposition)).toBe(false);
  });

  test("with newlineModifier ctrl, keeps Ctrl/Cmd+Enter as a newline and still sends plain Enter", () => {
    expect(
      shouldSendOnEnter({ ...baseEnter, ctrlKey: true }, noComposition, {
        newlineModifier: "ctrl",
      }),
    ).toBe(false);
    expect(
      shouldSendOnEnter({ ...baseEnter, metaKey: true }, noComposition, {
        newlineModifier: "ctrl",
      }),
    ).toBe(false);
    expect(
      shouldSendOnEnter({ ...baseEnter, shiftKey: true }, noComposition, {
        newlineModifier: "ctrl",
      }),
    ).toBe(true);
    expect(shouldSendOnEnter(baseEnter, noComposition, { newlineModifier: "ctrl" })).toBe(true);
  });

  test("ignores non-Enter keys", () => {
    expect(shouldSendOnEnter({ ...baseEnter, key: "a" }, noComposition)).toBe(false);
  });

  test("ignores Enter while nativeEvent.isComposing is true", () => {
    expect(shouldSendOnEnter({ ...baseEnter, isComposing: true }, noComposition)).toBe(false);
  });

  test("ignores Enter carrying the legacy keyCode 229 IME marker", () => {
    expect(shouldSendOnEnter({ ...baseEnter, keyCode: 229 }, noComposition)).toBe(false);
  });

  test("ignores Enter fired just after compositionend (Safari)", () => {
    const composition = { lastCompositionEndAt: 1000, now: 1000 + IME_ENTER_GUARD_MS - 1 };
    expect(shouldSendOnEnter(baseEnter, composition)).toBe(false);
  });

  test("sends Enter once the compositionend guard window has elapsed", () => {
    const composition = { lastCompositionEndAt: 1000, now: 1000 + IME_ENTER_GUARD_MS };
    expect(shouldSendOnEnter(baseEnter, composition)).toBe(true);
  });
});

function fileItem(file: File) {
  return { kind: "file", getAsFile: () => file };
}

function textItem() {
  return { kind: "string", getAsFile: () => null };
}

describe("filesFromPaste", () => {
  test("returns no files for a text-only paste", () => {
    expect(filesFromPaste({ files: [], items: [textItem()] })).toEqual([]);
  });

  test("returns no files when clipboardData is missing", () => {
    expect(filesFromPaste(null)).toEqual([]);
    expect(filesFromPaste(undefined)).toEqual([]);
  });

  test("reads files from clipboardData.files", () => {
    const file = new File(["contents"], "photo.png", { type: "image/png" });
    expect(filesFromPaste({ files: [file], items: [] })).toEqual([file]);
  });

  test("falls back to items with kind 'file' (e.g. a pasted screenshot)", () => {
    const file = new File(["contents"], "screenshot.png", { type: "image/png" });
    expect(filesFromPaste({ files: [], items: [textItem(), fileItem(file)] })).toEqual([file]);
  });

  test("prefers clipboardData.files over items when both are present", () => {
    const fromFiles = new File(["a"], "a.txt");
    const fromItems = new File(["b"], "b.txt");
    expect(filesFromPaste({ files: [fromFiles], items: [fileItem(fromItems)] })).toEqual([
      fromFiles,
    ]);
  });
});

describe("dragCarriesFiles", () => {
  test("is true when the native drag types include 'Files'", () => {
    expect(dragCarriesFiles(["Files"])).toBe(true);
    expect(dragCarriesFiles(["text/plain", "Files"])).toBe(true);
  });

  test("is false for a text or URL drag with no 'Files' type", () => {
    expect(dragCarriesFiles(["text/plain"])).toBe(false);
    expect(dragCarriesFiles(["text/uri-list", "text/plain"])).toBe(false);
  });

  test("is false when there are no drag types", () => {
    expect(dragCarriesFiles([])).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
    expect(dragCarriesFiles(undefined)).toBe(false);
  });
});

describe("filesFromDrop", () => {
  test("returns nothing for a text-only drop", () => {
    expect(filesFromDrop({ files: [], items: [textItem()] })).toEqual([]);
  });

  test("returns nothing when dataTransfer is missing", () => {
    expect(filesFromDrop(null)).toEqual([]);
    expect(filesFromDrop(undefined)).toEqual([]);
  });

  test("reads the file from dataTransfer.files", () => {
    const file = new File(["contents"], "photo.png", { type: "image/png" });
    expect(filesFromDrop({ files: [file], items: [] })).toEqual([file]);
  });

  test("falls back to items with kind 'file'", () => {
    const file = new File(["contents"], "report.pdf", { type: "application/pdf" });
    expect(filesFromDrop({ files: [], items: [textItem(), fileItem(file)] })).toEqual([file]);
  });

  test("keeps every file of a multi-file drop, in order, as the picker and paste do", () => {
    const first = new File(["a"], "first.txt");
    const second = new File(["b"], "second.txt");
    expect(filesFromDrop({ files: [first, second], items: [] })).toEqual([first, second]);
  });
});

describe("imageUrlsFromPaste", () => {
  const makeClipboard = (
    data: Record<string, string>,
    types: string[] = Object.keys(data),
  ): Parameters<typeof imageUrlsFromPaste>[0] => ({
    getData: (type: string) => data[type] ?? "",
    types,
  });

  test("returns [] for empty pastes and pastes without link payloads", () => {
    expect(imageUrlsFromPaste(null)).toEqual([]);
    expect(imageUrlsFromPaste({ getData: () => "", types: ["text/plain"] })).toEqual([]);
    expect(imageUrlsFromPaste({ getData: () => "", types: ["text/html"] })).toEqual([]);
  });

  test("never claims a plain-text link — those stay browser default, unprevented", () => {
    expect(
      imageUrlsFromPaste(
        makeClipboard({ "text/plain": "https://github.com/lrm-lab/coforge/pull/1" }),
      ),
    ).toEqual([]);
    expect(
      imageUrlsFromPaste(
        makeClipboard({
          "text/plain": "https://github.com/lrm-lab/coforge/pull/1",
          "text/html": '<a href="https://github.com/lrm-lab/coforge/pull/1">PR</a>',
        }),
      ),
    ).toEqual([]);
  });

  test("takes the single <img> from html-only pastes (web apps that ship no file bytes)", () => {
    expect(
      imageUrlsFromPaste(
        makeClipboard({
          "text/html": '<div><img alt="i" src="https://cdn.example.com/pic.jpg"></div>',
        }),
      ),
    ).toEqual(["https://cdn.example.com/pic.jpg"]);
  });

  test("several <img> elements read as rich text, not an intended image", () => {
    expect(
      imageUrlsFromPaste(
        makeClipboard({
          "text/html":
            '<div><img src="https://cdn.example.com/a.jpg"><img src="https://cdn.example.com/b.webp"></div>',
        }),
      ),
    ).toEqual([]);
  });

  test("ignores javascript: and data: sources", () => {
    expect(
      imageUrlsFromPaste(
        makeClipboard({
          "text/html": '<img src="data:image/png;base64,AAAA"><img src="javascript:alert(1)">',
        }),
      ),
    ).toEqual([]);
  });
});

describe("INLINE_IMAGE_TYPES", () => {
  test("matches the server's inline-image whitelist", () => {
    expect(INLINE_IMAGE_TYPES.has("image/tiff")).toBe(false);
    expect(INLINE_IMAGE_TYPES.has("image/png")).toBe(true);
  });
});

describe("localId", () => {
  test("returns a UUID shape when crypto.randomUUID is available (secure contexts, Bun tests)", () => {
    const id = localId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe(localId());
  });

  test("falls back to a unique non-UUID string when randomUUID throws", () => {
    const original = globalThis.crypto.randomUUID;
    try {
      globalThis.crypto.randomUUID = () => {
        throw new TypeError("randomUUID is not available in this secure context");
      };
      const id = localId();
      expect(id).toMatch(/^local-[0-9a-z]+-[0-9a-z]+$/);
      expect(id).not.toBe(localId());
    } finally {
      globalThis.crypto.randomUUID = original;
    }
  });
});
