import { describe, expect, test } from "bun:test";

import {
  findCaseInsensitiveMatches,
  planMatchEndpoints,
  stepMatchIndex,
} from "./artifact-markdown-find";
import { pickActiveHeadingIndex, relativeHeadingDepth } from "./artifact-markdown-outline";

describe("findCaseInsensitiveMatches", () => {
  test("returns empty for empty query or empty text", () => {
    expect(findCaseInsensitiveMatches("", "abc")).toEqual([]);
    expect(findCaseInsensitiveMatches("abc", "")).toEqual([]);
  });

  test("finds non-overlapping case-insensitive matches", () => {
    expect(findCaseInsensitiveMatches("Foo bar FOO baz foo", "foo")).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
      { start: 16, end: 19 },
    ]);
  });

  test("handles CJK and repeated substrings without overlapping", () => {
    expect(findCaseInsensitiveMatches("前端工程师和前端任务", "前端")).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ]);
    expect(findCaseInsensitiveMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});

describe("planMatchEndpoints", () => {
  test("maps single-span and cross-span inline matches", () => {
    const spans = [
      { start: 0, end: 6 },
      { start: 6, end: 11 },
      { start: 11, end: 17 },
    ];
    expect(planMatchEndpoints(spans, 1, 5)).toEqual({
      startIndex: 0,
      startOffset: 1,
      endIndex: 0,
      endOffset: 5,
    });
    expect(planMatchEndpoints(spans, 4, 13)).toEqual({
      startIndex: 0,
      startOffset: 4,
      endIndex: 2,
      endOffset: 2,
    });
  });

  test("handles block separator gaps between spans", () => {
    const spans = [
      { start: 0, end: 5 },
      { start: 6, end: 11 },
    ];
    expect(planMatchEndpoints(spans, 6, 11)).toEqual({
      startIndex: 1,
      startOffset: 0,
      endIndex: 1,
      endOffset: 5,
    });
    expect(planMatchEndpoints(spans, 5, 5)).toBeNull();
    expect(planMatchEndpoints([], 0, 2)).toBeNull();
  });
});

describe("stepMatchIndex", () => {
  test("returns -1 when total is zero", () => {
    expect(stepMatchIndex(0, 0, 1)).toBe(-1);
    expect(stepMatchIndex(-1, 0, -1)).toBe(-1);
  });

  test("starts at first or last match when current is out of bounds", () => {
    expect(stepMatchIndex(-1, 4, 1)).toBe(0);
    expect(stepMatchIndex(-1, 4, -1)).toBe(3);
  });

  test("wraps forward and backward cleanly", () => {
    expect(stepMatchIndex(0, 3, 1)).toBe(1);
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(stepMatchIndex(1, 3, -1)).toBe(0);
  });
});

describe("outline helpers", () => {
  test("picks the last heading at or above threshold", () => {
    expect(pickActiveHeadingIndex([], 80)).toBe(-1);
    expect(pickActiveHeadingIndex([120, 340, 600], 80)).toBe(0);
    expect(pickActiveHeadingIndex([-200, 40, 220], 80)).toBe(1);
    expect(pickActiveHeadingIndex([-400, -120, 80], 80)).toBe(2);
  });

  test("computes relative heading depth clamped to 0..2", () => {
    expect(relativeHeadingDepth(1, 1)).toBe(0);
    expect(relativeHeadingDepth(2, 1)).toBe(1);
    expect(relativeHeadingDepth(3, 1)).toBe(2);
    expect(relativeHeadingDepth(2, 2)).toBe(0);
    expect(relativeHeadingDepth(3, 2)).toBe(1);
  });
});
