import { expect, test } from "bun:test";
import { ANCHOR_DATA_MAX_BYTES } from "@lrm/coforge-sdk/agent";

import { commentAnchor } from "#src/features/artifacts/artifact-comment-inputs";
import { findQuote, joinPieces, quoteAnchor } from "#src/features/artifacts/artifact-text-anchor";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

test("a selection becomes a quote with the text around it", () => {
  const text = "Alpha beta gamma delta";
  const start = text.indexOf("beta");
  expect(quoteAnchor(text, start, start + 4)).toEqual({
    quote: "beta",
    prefix: "Alpha ",
    suffix: " gamma delta",
  });
});

test("surrounding whitespace is not part of the quote, and a blank selection is none", () => {
  const text = "one  two  three";
  expect(quoteAnchor(text, 3, 10)?.quote).toBe("two");
  expect(quoteAnchor(text, 3, 5)).toBeNull();
});

test("a quote and its context stay inside the anchor's byte budget", () => {
  const text = `${"中".repeat(3000)} end`;
  const anchor = quoteAnchor(text, 0, 3000)!;
  expect(bytes(anchor)).toBeLessThanOrEqual(ANCHOR_DATA_MAX_BYTES);
  expect(text.startsWith(anchor.quote)).toBe(true);
  expect(commentAnchor.safeParse({ type: "text", data: anchor }).success).toBe(true);
});

test("a quote is found again where it was, and the context picks between repeats", () => {
  const text = "red apple. green apple. blue apple.";
  const second = text.indexOf("apple", 11);
  const anchor = quoteAnchor(text, second, second + 5)!;
  expect(findQuote(text, anchor)).toEqual({ start: second, end: second + 5 });
  const edited = `intro. ${text}`;
  const moved = edited.indexOf("apple", 18);
  expect(findQuote(edited, anchor)).toEqual({ start: moved, end: moved + 5 });
});

test("a quote that is gone is not found", () => {
  const anchor = quoteAnchor("keep this sentence", 5, 9)!;
  expect(findQuote("keep that sentence", anchor)).toBeNull();
});

test("blocks join with a line break so a quote across them reads apart", () => {
  expect(
    joinPieces([
      ["Title", 1],
      ["Body", 2],
      ["more", 2],
    ]),
  ).toEqual({
    text: "Title\nBodymore",
    starts: [0, 6, 10],
  });
});

const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test("context never starts or ends inside an emoji", () => {
  const text = `${"😀".repeat(40)}xtarget${"😀".repeat(40)}`;
  const start = text.indexOf("target");
  const anchor = quoteAnchor(text, start, start + 6)!;
  expect(anchor.quote).toBe("target");
  expect(anchor.prefix!.endsWith("x")).toBe(true);
  expect(lone.test(anchor.prefix ?? "")).toBe(false);
  expect(lone.test(anchor.suffix ?? "")).toBe(false);
  expect(anchor.prefix).toContain("😀");
  expect(anchor.suffix).toContain("😀");
});

test("a selection that cuts an emoji in half keeps the whole emoji or none of it", () => {
  const text = "ab😀cd";
  const half = text.indexOf("😀") + 1;
  expect(lone.test(quoteAnchor(text, half, text.length)!.quote)).toBe(false);
  expect(lone.test(quoteAnchor(text, 0, half)!.quote)).toBe(false);
});

test("a short quote is found only where its context still matches", () => {
  const anchor = quoteAnchor("Price: 42 euros, see table", 7, 9)!;
  expect(findQuote("Price: 42 euros, see table", anchor)).toEqual({ start: 7, end: 9 });
  expect(findQuote("Total: 42 dollars elsewhere!", anchor)).toBeNull();
});

test("a short quote with no context is found only when it is unique", () => {
  expect(findQuote("one two", { quote: "two" })).toEqual({ start: 4, end: 7 });
  expect(findQuote("two and two", { quote: "two" })).toBeNull();
});

test("equal matches keep the first occurrence", () => {
  const text = "the long repeated sentence here, and the long repeated sentence here.";
  expect(findQuote(text, { quote: "the long repeated sentence here" })).toEqual({
    start: 0,
    end: 31,
  });
});
