import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { ANNOTATE_TEXT_SOURCE } from "#src/server/artifacts/artifact-page-annotate-locate-runtime.server";
import {
  collapsed,
  findQuote,
  joinPieces,
  quoteAnchor,
  type TextQuote,
} from "#src/features/artifacts/artifact-text-anchor";

const frame = new Function(
  `${ANNOTATE_TEXT_SOURCE}; return { quoteAnchor, findQuote, joinPieces, clip, collapsed, firstIndexWhere };`,
)() as {
  quoteAnchor: (text: string, start: number, end: number) => TextQuote | null;
  findQuote: (text: string, anchor: TextQuote) => { start: number; end: number } | null;
  joinPieces: (pieces: [string, unknown][]) => { text: string; starts: number[] };
  clip: (text: string, max: number) => string;
  collapsed: (raw: string) => { text: string; map: number[] };
  firstIndexWhere: (items: number[], reached: (item: number) => boolean) => number;
};

const long = `${"The quick brown fox jumps over the lazy dog. ".repeat(120)}end`;
const texts = [
  "Ship the beta on Friday. Pricing is open for review.",
  "ab ab ab ab ab ab",
  `first line\nsecond line\nthird 😀 line with emoji 😀 again`,
  long,
  "  padded   text  ",
  "",
];

describe("the page runtime's quote logic is generated from the host's", () => {
  test("the snippet needs nothing from the module it was written in", () => {
    const names = [
      "quoteAnchor",
      "findQuote",
      "joinPieces",
      "clip",
      "collapsed",
      "firstIndexWhere",
    ];
    const sample = JSON.stringify(texts[2]);
    const isolated = runInNewContext(
      `${ANNOTATE_TEXT_SOURCE}; const a = quoteAnchor(${sample}, 3, 30);
      ({ fns: [${names.join(", ")}], found: findQuote(${sample}, a), cut: clip(${sample}, 20),
         joined: joinPieces([["x", 1], ["y", 2]]).text, spaced: collapsed("a  b").text })`,
      { TextEncoder },
    ) as { fns: unknown[]; found: unknown; cut: string; joined: string; spaced: string };
    expect(isolated.fns.every((fn) => typeof fn === "function")).toBe(true);
    expect(isolated.found).toEqual(findQuote(texts[2]!, quoteAnchor(texts[2]!, 3, 30)!));
    expect(isolated.cut).toBe(frame.clip(texts[2]!, 20));
    expect(isolated.joined).toBe(
      joinPieces([
        ["x", 1],
        ["y", 2],
      ]).text,
    );
    expect(isolated.spaced).toBe("a b");
    expect(ANNOTATE_TEXT_SOURCE).not.toMatch(
      /__name\(|__publicField|__defProp|__vite_ssr|import\(/,
    );
  });
  test("the generated snippet evaluates and agrees on a few cases, surrogate pairs and long text included", () => {
    for (const text of texts)
      for (const start of [0, 5, 40])
        for (const length of [3, 12, 5000]) {
          const end = Math.min(text.length, start + length);
          expect(frame.quoteAnchor(text, start, end), `${text.length}:${start}-${end}`).toEqual(
            quoteAnchor(text, start, end),
          );
          const anchor = quoteAnchor(text, start, end);
          if (!anchor) continue;
          expect(frame.findQuote(text, anchor)).toEqual(findQuote(text, anchor));
          const moved = { ...anchor, prefix: "zzzz", suffix: "yyyy" };
          expect(frame.findQuote(text, moved)).toEqual(findQuote(text, moved));
        }
  });

  test("joinPieces separates blocks by a newline as the host does", () => {
    const pieces: [string, unknown][] = [
      ["Hello ", "p1"],
      ["world", "p1"],
      ["Next", "p2"],
    ];
    expect(frame.joinPieces(pieces)).toEqual(joinPieces(pieces));
    expect(frame.joinPieces(pieces).text).toBe("Hello world\nNext");
  });

  test("collapsed and firstIndexWhere come from the same source", () => {
    expect(frame.collapsed("a \n b")).toEqual(collapsed("a \n b"));
    expect(frame.firstIndexWhere([1, 3, 5], (value) => value >= 3)).toBe(1);
  });

  test("clip cuts a label to the limit without splitting a surrogate pair", () => {
    expect(frame.clip("short", 120)).toBe("short");
    const clipped = frame.clip(`${"a".repeat(118)}😀😀`, 120);
    expect(clipped.length).toBeLessThanOrEqual(120);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped).not.toMatch(/[\ud800-\udbff]…$/);
  });
});
