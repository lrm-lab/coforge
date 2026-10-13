import { expect, test } from "bun:test";

import { messagePreviewLine } from "#src/server/conversations/message-preview-line.server";

const helperId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const helper = { kind: "agent", actorId: helperId, handle: "helper" };

test("newlines and runs of whitespace collapse into one line", () => {
  expect(messagePreviewLine("line one\n\nline two\r\n\tthree   four\n", [])).toBe(
    "line one line two three four",
  );
});

test("markdown stays as plain text", () => {
  const body = "**bold** and `code`\n- [link](https://example.com)";
  expect(messagePreviewLine(body, [])).toBe("**bold** and `code` - [link](https://example.com)");
});

test("a mention token reads as its @handle", () => {
  expect(messagePreviewLine(`hi <@agent:${helperId}> look`, [helper])).toBe("hi @helper look");
});

test("a body of only whitespace or nothing is an empty preview", () => {
  expect(messagePreviewLine("", [])).toBe("");
  expect(messagePreviewLine(" \n\t ", [])).toBe("");
});

test("a preview of 120 characters or fewer is kept whole", () => {
  const exact = "a".repeat(120);
  expect(messagePreviewLine(exact, [])).toBe(exact);
});

test("a longer preview is cut to 119 characters and an ellipsis", () => {
  expect(messagePreviewLine("a".repeat(121), [])).toBe(`${"a".repeat(119)}…`);
});

test("truncation counts emoji as one character each", () => {
  const emoji = "😀".repeat(130);
  expect(messagePreviewLine(emoji, [])).toBe(`${"😀".repeat(119)}…`);
});

test("truncation counts CJK characters as one character each", () => {
  const cjk = "中".repeat(121);
  expect(messagePreviewLine(cjk, [])).toBe(`${"中".repeat(119)}…`);
});

test("truncation never splits a ZWJ emoji sequence", () => {
  const family = "👨‍👩‍👧‍👦";
  // 118 letters, the family (one character, seven code points), then "b": 120 characters.
  const body = `${"a".repeat(118)}${family}b`;
  expect(messagePreviewLine(body, [])).toBe(body);
  // One more character pushes the family past the limit: it moves whole into the cut.
  expect(messagePreviewLine(`${body}c`, [])).toBe(`${"a".repeat(118)}${family}…`);
});

test("truncation never splits a flag or a skin-tone modifier", () => {
  const flag = "🇯🇵";
  // 118 letters and a flag (one character, two code points) is 119 characters: kept whole.
  expect(messagePreviewLine(`${"a".repeat(118)}${flag}`, [])).toBe(`${"a".repeat(118)}${flag}`);
  // 118 letters, a flag and two letters is 121 characters: the cut keeps the flag whole.
  expect(messagePreviewLine(`${"a".repeat(118)}${flag}bc`, [])).toBe(`${"a".repeat(118)}${flag}…`);
  const thumbsUp = "👍🏽";
  // 119 letters and the thumb are 120 characters: kept whole. One more letter cuts before the thumb.
  expect(messagePreviewLine(`${"a".repeat(119)}${thumbsUp}`, [])).toBe(
    `${"a".repeat(119)}${thumbsUp}`,
  );
  expect(messagePreviewLine(`${"a".repeat(119)}${thumbsUp}x`, [])).toBe(`${"a".repeat(119)}…`);
});
