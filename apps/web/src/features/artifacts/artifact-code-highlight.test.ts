import { describe, expect, test } from "bun:test";

import { highlightCodeByLanguage, highlightCodeLines } from "./artifact-code-highlight";

describe("highlightCodeLines", () => {
  test("highlights TypeScript code and preserves exact physical line count", () => {
    const source = "const count = 1;\n\nexport function inc() {\n  return count + 1;\n}\n";
    const lines = highlightCodeLines(source, "src/counter.ts");
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(5);
    expect(lines![0]!.some((token) => token.className?.includes("hljs-keyword"))).toBe(true);
    expect(lines![1]).toEqual([]);
    expect(lines!.map((line) => line.map((token) => token.text).join(""))).toEqual(
      source.replace(/\n$/, "").split("\n"),
    );
  });

  test("preserves multi-line block comment classes on every spanned line", () => {
    const source = "/* line one\n   line two\n   line three */\nconst x = 42;";
    const lines = highlightCodeLines(source, "app.js");
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(4);
    expect(lines![0]!.every((token) => token.className?.includes("hljs-comment"))).toBe(true);
    expect(lines![1]!.every((token) => token.className?.includes("hljs-comment"))).toBe(true);
    expect(lines![2]!.every((token) => token.className?.includes("hljs-comment"))).toBe(true);
    expect(lines!.map((line) => line.map((token) => token.text).join(""))).toEqual(
      source.split("\n"),
    );
  });

  test("falls back to null for plaintext, unknown extensions, and oversized files", () => {
    expect(highlightCodeLines("hello world", "notes.txt")).toBeNull();
    expect(highlightCodeLines("binary-ish", "archive.unknownext")).toBeNull();
    expect(highlightCodeLines("x".repeat(260_000), "huge.ts")).toBeNull();
  });

  test("highlights JSON and Python files cleanly", () => {
    const jsonLines = highlightCodeLines('{"ok": true}\n', "data.json");
    expect(jsonLines).not.toBeNull();
    expect(jsonLines!.length).toBe(1);
    expect(jsonLines![0]!.some((token) => token.className?.includes("hljs-attr"))).toBe(true);

    const pyLines = highlightCodeLines("def run():\n    return 'ok'\n", "script.py");
    expect(pyLines).not.toBeNull();
    expect(pyLines!.length).toBe(2);
    expect(pyLines![0]!.some((token) => token.className?.includes("hljs-keyword"))).toBe(true);
  });

  test("highlights fenced code blocks by language and falls back for plaintext or unknown", () => {
    const tsLines = highlightCodeByLanguage("const week = 48;\n", "ts");
    expect(tsLines).not.toBeNull();
    expect(tsLines!.length).toBe(1);
    expect(tsLines![0]!.some((token) => token.className?.includes("hljs-keyword"))).toBe(true);

    expect(highlightCodeByLanguage("plain", "plaintext")).toBeNull();
    expect(highlightCodeByLanguage("plain", "text")).toBeNull();
    expect(highlightCodeByLanguage("custom", "nonexistent-lang")).toBeNull();
  });
});
