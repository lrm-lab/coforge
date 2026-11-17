import { expect, test } from "bun:test";
import {
  isLongMessage,
  LONG_MESSAGE_PREVIEW_CHARS,
  longMessageAsFile,
  MESSAGE_BODY_MAX_LENGTH,
} from "./long-message";

const now = new Date(2026, 10, 17, 9, 5, 3);
const note = "Full text in the attached file.";

test("exactly the limit is a message; one more, or more after trimming, is a file", () => {
  expect(isLongMessage("a".repeat(MESSAGE_BODY_MAX_LENGTH))).toBe(false);
  expect(isLongMessage("a".repeat(MESSAGE_BODY_MAX_LENGTH + 1))).toBe(true);
  // The server trims before it measures, so surrounding blanks never tip a body over.
  expect(isLongMessage(`  ${"a".repeat(MESSAGE_BODY_MAX_LENGTH)}\n\n`)).toBe(false);
});

test("the file holds the whole body and is named by the sender's local time", () => {
  const body = `${"line\n".repeat(3000)}end`;
  const file = longMessageAsFile(body, { note, now });
  expect(file.content).toBe(`${body.trim()}\n`);
  expect(file.fileName).toBe("message-20261117-090503.md");
});

test("the preview keeps the first five lines, marks the cut, and ends with the note", () => {
  const body = ["one", "two", "three", "four", "five", "six", "x".repeat(9000)].join("\n");
  expect(longMessageAsFile(body, { note, now }).preview).toBe(
    `one\ntwo\nthree\nfour\nfive…\n\n${note}`,
  );
});

test("one long line is cut at the character limit, never through an emoji", () => {
  const plain = longMessageAsFile("y".repeat(9000), { note, now }).preview;
  expect(plain).toBe(`${"y".repeat(LONG_MESSAGE_PREVIEW_CHARS)}…\n\n${note}`);
  // An emoji straddling the limit is left out whole rather than split.
  const body = `${"y".repeat(LONG_MESSAGE_PREVIEW_CHARS - 1)}😀${"y".repeat(9000)}`;
  const preview = longMessageAsFile(body, { note, now }).preview;
  expect(preview.startsWith(`${"y".repeat(LONG_MESSAGE_PREVIEW_CHARS - 1)}…`)).toBe(true);
  expect(preview.length).toBeLessThanOrEqual(MESSAGE_BODY_MAX_LENGTH);
});

test("a preview that stops inside a code block closes it, so the note stays outside", () => {
  const body = ["Logs:", "```", "a", "b", "c", "d", "e".repeat(9000), "```"].join("\n");
  expect(longMessageAsFile(body, { note, now }).preview).toBe(
    `Logs:\n\`\`\`\na\nb\nc…\n\`\`\`\n\n${note}`,
  );
});

test("a mention past the preview follows the note, so its person is still notified", () => {
  const body = [
    "@alice please read",
    "two",
    "three",
    "four",
    "five",
    "six: @bob and @alice again, `@not_in_code`",
    "x".repeat(9000),
    "@carol-2",
  ].join("\n");
  expect(longMessageAsFile(body, { note, now }).preview).toBe(
    `@alice please read\ntwo\nthree\nfour\nfive…\n\n${note}\n@bob @carol-2`,
  );
  // Nothing past the preview to name: no extra line.
  expect(longMessageAsFile("y".repeat(9000), { note, now }).preview.endsWith(note)).toBe(true);
});
