import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContextViewSource } from "#src/agent-context-view/context-view-source";
import { redactContextViewValue } from "#src/agent-context-view/context-view-redaction";

describe("context view source security", () => {
  test("reads only a private regular file below an allowed root", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-source-"));
    const file = join(root, "session.jsonl");
    writeFileSync(file, "hello", "utf8");
    expect(readContextViewSource(file, [root])).toMatchObject({ ok: true, sourceBytes: 5 });
    const other = join(root, "other");
    mkdirSync(other);
    expect(readContextViewSource(file, [other])).toMatchObject({
      ok: false,
      failure: "outside_root",
    });
  });

  test("classifies missing roots and files outside the allowed roots", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-source-"));
    const outside = mkdtempSync(join(tmpdir(), "coforge-context-outside-"));
    const file = join(outside, "session.jsonl");
    writeFileSync(file, "hello", "utf8");
    expect(readContextViewSource(file, [root])).toMatchObject({
      ok: false,
      failure: "outside_root",
    });
    expect(
      readContextViewSource(join(root, "missing.jsonl"), [join(root, "missing-root")]),
    ).toMatchObject({ ok: false, failure: "outside_root" });
  });

  test("rejects symlinks, hardlinks, and oversized sources", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-source-"));
    const file = join(root, "session.jsonl");
    writeFileSync(file, "hello", "utf8");
    const link = join(root, "link.jsonl");
    symlinkSync(file, link);
    expect(readContextViewSource(link, [root])).toMatchObject({ ok: false, failure: "unsafe" });
    const hard = join(root, "hard.jsonl");
    linkSync(file, hard);
    expect(readContextViewSource(hard, [root])).toMatchObject({ ok: false, failure: "unsafe" });
    const large = join(root, "large.jsonl");
    writeFileSync(large, "hello", "utf8");
    expect(readContextViewSource(large, [root], 2)).toMatchObject({
      ok: false,
      failure: "too_large",
    });
  });
});

test("replaces inline media and diagnostic URLs without preserving payloads", () => {
  const counts = { media: 0, diagnostic: 0 };
  const value = redactContextViewValue(
    {
      image: `data:image/png;base64,${"A".repeat(1024)}`,
      blob: { media_type: "image/png", data: "A".repeat(1024) },
      bytes: new Uint8Array([1, 2]),
      url: "https://x.test?token=secret",
    },
    counts,
  ) as Record<string, string | Record<string, string>>;
  expect(value.image).toContain("[raft:media image/png");
  expect((value.blob as Record<string, string>).data).toContain("[raft:media image/png");
  expect(String(value.bytes)).toContain("[raft:media unknown");
  expect(value.url).toBe("https://x.test/?[REDACTED_QUERY]");
  expect(counts).toEqual({ media: 3, diagnostic: 1 });
});
