import { expect, test } from "bun:test";
import {
  anchorRangeLabel,
  anchorTypeForPreview,
  headingIds,
  headingSlug,
  rangeLocator,
  sectionLocator,
  parseAttachmentCommentAnchor,
  sectionAt,
  storedText,
  videoTimeLabel,
} from "#src/features/conversations/attachment-comment-anchors";
import { parseCsv } from "#src/features/conversations/csv-table";

test("a heading's slug follows GitHub's, keeping letters in any script", () => {
  expect(headingSlug("Getting Started!")).toBe("getting-started");
  expect(headingSlug("  API: v2 (beta)  ")).toBe("api-v2-beta");
  expect(headingSlug("安装 步骤")).toBe("安装-步骤");
  expect(headingSlug("snake_case & more")).toBe("snake_case--more");
});

test("a repeated heading takes the next number, as GitHub numbers them", () => {
  expect(headingIds(["Usage", "Notes", "Usage", "Usage"])).toEqual([
    "usage",
    "notes",
    "usage-1",
    "usage-2",
  ]);
});

test("a section is found by id, then by title, else it is lost", () => {
  const titles = ["Intro", "Usage", "Usage"];
  expect(sectionLocator(titles)({ headingId: "usage-1", headingTitle: "Usage" })).toBe(2);
  // A heading above it was removed: the id now names nothing, the title still does.
  expect(sectionLocator(titles)({ headingId: "setup-1", headingTitle: "Intro" })).toBe(0);
  expect(sectionLocator(titles)({ headingId: "gone", headingTitle: "Gone" })).toBeNull();
});

test("a section anchor is cut to the stored bound and still found by the same bound", () => {
  const long = "A".repeat(250);
  const titles = ["Intro", long];
  const section = sectionAt(titles, 1)!;
  expect(section.headingTitle).toHaveLength(200);
  expect(section.headingId).toHaveLength(200);
  expect(sectionLocator(titles)(section)).toBe(1);
  expect(sectionAt(titles, -1)).toBeNull();
  expect(sectionAt(["   "], 0)).toBeNull();
});

test("a range holds while it fits, and without a quote is lost past the end", () => {
  const lines = ["a", "b", "c", "d", "e"];
  expect(rangeLocator(lines)({ start: 3, end: 5 })).toEqual({ start: 3, end: 5 });
  expect(rangeLocator(lines)({ start: 3, end: 6 })).toBeNull();
});

test("a quote confirms the range, or finds where the text moved, or marks it lost", () => {
  const lines = ["intro", "alpha  beta", "gamma", "delta"];
  expect(rangeLocator(lines)({ start: 2, end: 3, quote: "beta gamma" })).toEqual({
    start: 2,
    end: 3,
  });
  // Two lines were inserted above: the same text now sits two lines lower.
  const moved = ["new", "new", ...lines];
  expect(rangeLocator(moved)({ start: 2, end: 3, quote: "beta gamma" })).toEqual({
    start: 4,
    end: 5,
  });
  expect(rangeLocator(lines)({ start: 2, end: 3, quote: "omega" })).toBeNull();
  // Blank lines between the quoted ones fold away, as they do when the quote is read.
  expect(
    rangeLocator(["x", "alpha", "", "beta"])({ start: 9, end: 9, quote: "alpha beta" }),
  ).toEqual({
    start: 2,
    end: 4,
  });
});

test("each preview offers its own anchor type; the others are whole-file only", () => {
  expect(anchorTypeForPreview("markdown")).toBe("md-section");
  expect(anchorTypeForPreview("text")).toBe("lines");
  expect(anchorTypeForPreview("csv")).toBe("csv-rows");
  expect(anchorTypeForPreview("html")).toBe("html-region");
  expect(anchorTypeForPreview("video")).toBe("video-timestamp");
  for (const kind of ["pdf", "audio", null] as const) expect(anchorTypeForPreview(kind)).toBeNull();
});

test("an anchor's label is its heading, or its first and last line or row", () => {
  expect(
    anchorRangeLabel({ type: "md-section", data: { headingId: "a", headingTitle: "Setup" } }),
  ).toBe("Setup");
  expect(anchorRangeLabel({ type: "lines", data: { start: 3, end: 3 } })).toBe("3");
  expect(anchorRangeLabel({ type: "csv-rows", data: { start: 2, end: 9 } })).toBe("2–9");
});

const region = {
  x: 10,
  y: 400,
  w: 0,
  h: 0,
  viewportWidth: 800,
  documentWidth: 800,
  documentHeight: 3000,
};

test("an HTML region is a box in document pixels; a click is a box of no size", () => {
  expect(parseAttachmentCommentAnchor({ type: "html-region", data: region })).toEqual({
    type: "html-region",
    data: region,
  });
  for (const data of [
    { ...region, x: -1 },
    { ...region, w: 1.5 },
    { ...region, y: Number.POSITIVE_INFINITY },
    { ...region, quote: "" },
    { x: 1, y: 1, w: 1, h: 1 },
    { ...region, extra: 1 },
  ])
    expect(parseAttachmentCommentAnchor({ type: "html-region", data })).toBeNull();
});

test("a region's label is its quote cut to 36 characters, or empty for the generic name", () => {
  const quote = "🚀".repeat(40);
  expect(anchorRangeLabel({ type: "html-region", data: { ...region, quote } })).toBe(
    `${"🚀".repeat(36)}…`,
  );
  expect(anchorRangeLabel({ type: "html-region", data: { ...region, quote: "Pricing" } })).toBe(
    "Pricing",
  );
  expect(anchorRangeLabel({ type: "html-region", data: region })).toBe("");
});

test("CSV parses as RFC 4180: quoted commas, line breaks and doubled quotes", () => {
  expect(parseCsv('name,note\r\n"Lee, A","said ""hi""\nthen left"\nB,\n')).toEqual([
    ["name", "note"],
    ["Lee, A", 'said "hi"\nthen left'],
    ["B", ""],
  ]);
  expect(parseCsv("")).toEqual([]);
  expect(parseCsv("a,b")).toEqual([["a", "b"]]);
  // A blank line is no row; a quoted empty field on its own line is one.
  expect(parseCsv("a,\n\nb,\r\n\r\n")).toEqual([
    ["a", ""],
    ["b", ""],
  ]);
  expect(parseCsv('a\n""\nb')).toEqual([["a"], [""], ["b"]]);
  expect(parseCsv('"x"y,z')).toEqual([["xy", "z"]]);
  // Lenient: a quote inside an unquoted field is text, an unterminated quote runs to the end.
  expect(parseCsv('5" pipe,x\n"open')).toEqual([['5" pipe', "x"], ["open"]]);
});

test("only a well-formed anchor of a known type parses", () => {
  const section = {
    type: "md-section",
    data: { headingId: "usage", headingTitle: "Usage", quote: "run it" },
  } as const;
  expect(parseAttachmentCommentAnchor(section)).toEqual(section);
  const rows = { type: "csv-rows", data: { start: 2, end: 4, quote: "Lee, A" } } as const;
  expect(parseAttachmentCommentAnchor(rows)).toEqual(rows);
  for (const bad of [
    { type: "lines", data: { start: 4, end: 2 } },
    { type: "lines", data: { start: 0, end: 2 } },
    { type: "lines", data: { start: 1, end: 2, extra: true } },
    { type: "md-section", data: { headingId: "x", headingTitle: "  " } },
    { type: "lines", data: { start: 1, end: 2, quote: "a\u0000b" } },
    { type: "lines", data: { start: 1, end: 2, quote: "bell\u0007" } },
    { type: "lines", data: { start: 1, end: 2, quote: "half \uD83D" } },
    { type: "md-section", data: { headingId: "x".repeat(201), headingTitle: "Usage" } },
    { type: "lines", data: { start: 1, end: 2, quote: "q".repeat(501) } },
    { type: "page", data: {} },
    null,
  ] as unknown[])
    expect(parseAttachmentCommentAnchor(bad)).toBeNull();
});

test("kept text never splits a character or holds control characters", () => {
  expect(storedText("  a\n\tb  ", 10)).toBe("a b");
  expect(storedText("x\u0000y\u0007z", 10)).toBe("xyz");
  expect(storedText("ab🚀", 3)).toBe("ab");
  expect(storedText("ab🚀", 4)).toBe("ab🚀");
});

test("a heading with no slug is still a section, found by its title", () => {
  const titles = ["Intro", "🚀", "🚀"];
  const section = sectionAt(titles, 1)!;
  expect(section).toEqual({ headingId: "", headingTitle: "🚀" });
  expect(parseAttachmentCommentAnchor({ type: "md-section", data: section })).not.toBeNull();
  expect(sectionLocator(titles)(section)).toBe(1);
  expect(sectionLocator(titles)(sectionAt(titles, 2)!)).toBe(2);
});

test("a quote across table cells matches its row, however the cells were joined", () => {
  const rows = ["1 alpha beta", "2 gamma delta"];
  expect(rangeLocator(rows)({ start: 2, end: 2, quote: "2gamma\tdelta" })).toEqual({
    start: 2,
    end: 2,
  });
  expect(rangeLocator(["x", ...rows])({ start: 2, end: 2, quote: "2gammadelta" })).toEqual({
    start: 3,
    end: 3,
  });
});

test("a video time is kept to the millisecond, above 0 and at most 24 hours", () => {
  const at = (time: unknown) =>
    parseAttachmentCommentAnchor({ type: "video-timestamp", data: { time } });
  expect(at(83.417)).toEqual({ type: "video-timestamp", data: { time: 83.417 } });
  expect(at(24 * 60 * 60)).not.toBeNull();
  for (const time of [0, -1, 24 * 60 * 60 + 1, Number.NaN, Number.POSITIVE_INFINITY, "83"])
    expect(at(time)).toBeNull();
  expect(
    parseAttachmentCommentAnchor({ type: "video-timestamp", data: { time: 5, quote: "x" } }),
  ).toBeNull();
});

test("a video time reads as m:ss, and h:mm:ss from an hour on", () => {
  expect(videoTimeLabel(0.4)).toBe("0:00");
  expect(videoTimeLabel(83.9)).toBe("1:23");
  expect(videoTimeLabel(3_599)).toBe("59:59");
  expect(videoTimeLabel(3_725)).toBe("1:02:05");
  expect(anchorRangeLabel({ type: "video-timestamp", data: { time: 83.4 } })).toBe("1:23");
});
