import { expect, test } from "bun:test";
import { mergeText } from "#src/server/artifacts/artifact-merge.server";

/** A document's paragraphs, separated by blank lines, ending in a newline. */
const doc = (...paragraphs: string[]) => `${paragraphs.join("\n\n")}\n`;

test("changes to different paragraphs merge, and the same change on both sides is taken once", () => {
  expect(mergeText(doc("a", "b", "c"), doc("A", "b", "c"), doc("a", "b", "C"))).toEqual({
    text: doc("A", "b", "C"),
  });
  expect(mergeText(doc("a", "b"), doc("A", "b"), doc("A", "b"))).toEqual({ text: doc("A", "b") });
});

test("a paragraph added or removed next to the one the other side edited is no conflict", () => {
  // Inserted right before the paragraph the others edited.
  expect(mergeText(doc("a", "b", "c"), doc("a", "new", "b", "c"), doc("a", "B", "c"))).toEqual({
    text: doc("a", "new", "B", "c"),
  });
  // Removed right before the paragraph the others edited.
  expect(mergeText(doc("a", "b", "c"), doc("a", "c"), doc("a", "b", "C"))).toEqual({
    text: doc("a", "C"),
  });
  // Inserted right after it.
  expect(mergeText(doc("a", "b", "c"), doc("a", "b", "new", "c"), doc("a", "B", "c"))).toEqual({
    text: doc("a", "B", "new", "c"),
  });
});

test("the same paragraph changed on both sides, or removed on one, is a conflict in file order", () => {
  expect(mergeText(doc("a", "b", "c"), doc("a", "mine", "c"), doc("a", "theirs", "c"))).toEqual({
    chunks: [
      { ok: "a\n\n" },
      { conflict: { base: "b\n", mine: "mine\n", theirs: "theirs\n" } },
      { ok: "\nc\n" },
    ],
  });
  const removed = mergeText(doc("a", "b", "c"), doc("a", "B", "c"), doc("a", "c"));
  expect("chunks" in removed).toBe(true);
  // Two different paragraphs added at the same place cannot be ordered for them.
  expect("chunks" in mergeText(doc("a", "c"), doc("a", "x", "c"), doc("a", "y", "c"))).toBe(true);
});

test("a line added to a paragraph the other side removed is a conflict, wherever it sits", () => {
  // Above a middle paragraph the others removed.
  expect("chunks" in mergeText(doc("a", "b", "c"), doc("a", "c"), doc("a", "new\nb", "c"))).toBe(
    true,
  );
  // Under the last paragraph, which the others removed.
  expect("chunks" in mergeText(doc("a", "b"), doc("a"), doc("a", "b\nmore"))).toBe(true);
  // Under a middle one.
  expect("chunks" in mergeText(doc("a", "b", "c"), doc("a", "c"), doc("a", "b\nmore", "c"))).toBe(
    true,
  );
});

test("two lines of one paragraph changed by each side are the same paragraph, so a conflict", () => {
  const base = doc("a", "one\ntwo\nthree", "c");
  const merged = mergeText(
    base,
    doc("a", "ONE\ntwo\nthree", "c"),
    doc("a", "one\ntwo\nTHREE", "c"),
  );
  expect(merged).toEqual({
    chunks: [
      { ok: "a\n\n" },
      {
        conflict: {
          base: "one\ntwo\nthree\n",
          mine: "ONE\ntwo\nthree\n",
          theirs: "one\ntwo\nTHREE\n",
        },
      },
      { ok: "\nc\n" },
    ],
  });
});

test("a last line without a newline is kept as it is", () => {
  expect(mergeText("a\n\nb", "A\n\nb", "a\n\nb!")).toEqual({ text: "A\n\nb!" });
});

test("a 2 MiB document with edits scattered on both sides merges well under a second", () => {
  const paragraphs = Array.from(
    { length: 30_000 },
    (_, index) => `Paragraph ${index} ${"x".repeat(40)}`,
  );
  const base = doc(...paragraphs);
  const edit = (every: number, offset: number, mark: string) =>
    doc(...paragraphs.map((text, index) => (index % every === offset ? `${text} ${mark}` : text)));
  const started = performance.now();
  const merged = mergeText(base, edit(50, 0, "mine"), edit(50, 25, "theirs"));
  expect(performance.now() - started).toBeLessThan(1_000);
  expect("text" in merged).toBe(true);
  expect(base.length).toBeGreaterThan(1.5 * 1024 * 1024);
});

test("joining two paragraphs covers both, so the others' edit to the lower one conflicts", () => {
  expect("chunks" in mergeText(doc("a", "b", "c"), "a\n\nb\nc\n", doc("a", "b", "C"))).toBe(true);
});

test("one paragraph of 2 MiB with many edits on both sides is decided in bounded time", () => {
  // No blank lines at all: every edit is in the one paragraph, found once, not walked per edit.
  const lines = Array.from({ length: 300_000 }, (_, index) => `l${index % 10}`);
  const edit = (offset: number, mark: string) =>
    `${lines.map((line, index) => (index % 600 === offset ? `${line}${mark}` : line)).join("\n")}\n`;
  const base = `${lines.join("\n")}\n`;
  const started = performance.now();
  const merged = mergeText(base, edit(0, "m"), edit(300, "t"));
  expect(performance.now() - started).toBeLessThan(4_000);
  expect("chunks" in merged).toBe(true);
});

test("a side too different to align in bounded time is one whole-file conflict, quickly", () => {
  // 50,000 short lines that one side rewrote entirely: Myers' diff would take tens of seconds.
  const base = Array.from({ length: 50_000 }, (_, index) => `${index}\n`).join("");
  const rewritten = Array.from({ length: 50_000 }, (_, index) => `x${index}\n`).join("");
  const edited = base.replace("17\n", "seventeen\n");
  const started = performance.now();
  const merged = mergeText(base, rewritten, edited);
  expect(performance.now() - started).toBeLessThan(3_000);
  expect(merged).toEqual({ chunks: [{ conflict: { base, mine: rewritten, theirs: edited } }] });
});
