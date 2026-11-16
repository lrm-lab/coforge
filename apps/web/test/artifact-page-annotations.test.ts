import { describe, expect, test } from "bun:test";
import { describeAnchor } from "#src/features/artifacts/artifact-comment-anchor";
import {
  MARKS_MAX,
  clipAnchor,
  markPlaces,
  sameAnchor,
  type PageMark,
} from "#src/features/artifacts/artifact-page-annotations";

const mark = (id: string): PageMark => ({
  id,
  anchor: { type: "element", data: { selector: "p" } },
  count: 1,
  label: "l",
});

describe("what the composer shows of a page anchor", () => {
  test("an element anchor shows its label, and its selector, truncated, without one", () => {
    expect(
      describeAnchor({ type: "element", data: { selector: "h1", quote: "Launch plan" } }).quote,
    ).toBe("Launch plan");
    const shown = describeAnchor({
      type: "element",
      data: { selector: `body > ${"div > ".repeat(60)}p` },
    }).quote!;
    expect(shown.length).toBeLessThanOrEqual(120);
    expect(shown.startsWith("body > div")).toBe(true);
    expect(describeAnchor({ type: "text", data: { quote: "beta" } }).quote).toBe("beta");
  });
});

describe("marks and their places", () => {
  test("anchors are the same when type and every data field are", () => {
    const element = { type: "element", data: { selector: "h1", quote: "A" } } as const;
    expect(sameAnchor(element, { ...element, data: { quote: "A", selector: "h1" } })).toBe(true);
    expect(sameAnchor(element, { ...element, data: { selector: "h1" } })).toBe(false);
    expect(sameAnchor(element, { type: "text", data: { selector: "h1", quote: "A" } })).toBe(false);
  });

  test("nothing is placed before the frame reports", () => {
    expect(markPlaces([mark("a")], null).size).toBe(0);
  });

  test("a reported mark is found in report order, an unreported one is changed", () => {
    const places = markPlaces([mark("a"), mark("b")], ["b"]);
    expect(places.get("b")).toEqual({ status: "found", location: { order: 0 } });
    expect(places.get("a")).toEqual({ status: "changed" });
  });

  test("marks past the cap the frame is sent stay unplaced, so they read as neutral", () => {
    const marks = Array.from({ length: MARKS_MAX + 2 }, (_, i) => mark(`c${i}`));
    const places = markPlaces(marks, []);
    expect(places.size).toBe(MARKS_MAX);
    expect(places.has(`c${MARKS_MAX}`)).toBe(false);
  });
});

describe("anchors the frame is sent", () => {
  test("clipping never splits a surrogate pair at either end", () => {
    const emoji = "😀";
    const clipped = clipAnchor({
      type: "text",
      data: {
        quote: `${"a".repeat(3999)}${emoji}`,
        prefix: `${emoji}${"b".repeat(63)}`,
        suffix: `${"c".repeat(63)}${emoji}`,
      },
    }).data as { quote: string; prefix: string; suffix: string };
    expect(clipped.quote).toBe("a".repeat(3999));
    expect(clipped.prefix).toBe("b".repeat(63));
    expect(clipped.suffix).toBe("c".repeat(63));
    expect(
      clipAnchor({ type: "text", data: { quote: "short", prefix: "p", suffix: "s" } }).data,
    ).toEqual({
      quote: "short",
      prefix: "p",
      suffix: "s",
    });
  });
});
