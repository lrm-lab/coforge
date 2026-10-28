import { expect, test } from "bun:test";

import { opensKeyboard } from "#src/hooks/use-keyboard-field-focused";

test("text fields and editable text bring up the keyboard", () => {
  expect(opensKeyboard({ tagName: "TEXTAREA" })).toBe(true);
  expect(opensKeyboard({ tagName: "INPUT", type: "text" })).toBe(true);
  expect(opensKeyboard({ tagName: "INPUT", type: "search" })).toBe(true);
  expect(opensKeyboard({ tagName: "DIV", isContentEditable: true })).toBe(true);
});

test("a dialog, a button or a checkbox having focus means no keyboard, so a dialog fills the screen", () => {
  expect(opensKeyboard({ tagName: "SECTION" })).toBe(false);
  expect(opensKeyboard({ tagName: "BUTTON" })).toBe(false);
  expect(opensKeyboard({ tagName: "INPUT", type: "checkbox" })).toBe(false);
  expect(opensKeyboard(null)).toBe(false);
});
