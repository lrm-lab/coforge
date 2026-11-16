import { expect, test } from "bun:test";
import { isHeldEnter } from "#src/hooks/held-enter";

const key = (key: string, repeat: boolean, target: object | null) =>
  ({ key, repeat, target }) as unknown as Parameters<typeof isHeldEnter>[0];

test("a held Enter's repeats never activate a button, link or single-line field (task #101)", () => {
  for (const tagName of ["BUTTON", "A", "INPUT", "DIV"])
    expect(isHeldEnter(key("Enter", true, { tagName, isContentEditable: false }))).toBe(true);
  expect(isHeldEnter(key("Enter", true, null))).toBe(true);
});

test("a fresh Enter, another key, and Enter held in a multi-line field pass", () => {
  expect(isHeldEnter(key("Enter", false, { tagName: "BUTTON" }))).toBe(false);
  expect(isHeldEnter(key("ArrowDown", true, { tagName: "BUTTON" }))).toBe(false);
  expect(isHeldEnter(key("Enter", true, { tagName: "TEXTAREA" }))).toBe(false);
  expect(isHeldEnter(key("Enter", true, { tagName: "DIV", isContentEditable: true }))).toBe(false);
});
