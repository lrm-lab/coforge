import { expect, test } from "bun:test";

import {
  cssToNoteColor,
  cssToNoteFontSize,
  fontSizeToCss,
  NOTE_COLORS,
  NOTE_FONT_SIZES,
  noteColorToCss,
  sanitizeTextStyle,
} from "#src/features/records/report-editor/utils/text-style";

test("fontSizeToCss emits rem values while keeping stored NoteFontSize keys intact", () => {
  expect(NOTE_FONT_SIZES).toEqual(["14", "16", "18", "20", "24"]);
  expect(fontSizeToCss("14")).toBe("0.875rem");
  expect(fontSizeToCss("16")).toBe("1rem");
  expect(fontSizeToCss("18")).toBe("1.125rem");
  expect(fontSizeToCss("20")).toBe("1.25rem");
  expect(fontSizeToCss("24")).toBe("1.5rem");
});

test("cssToNoteFontSize and sanitizeTextStyle round-trip rem and legacy px marks", () => {
  expect(cssToNoteFontSize("1.125rem")).toBe("18");
  expect(cssToNoteFontSize("18px")).toBe("18");
  expect(cssToNoteFontSize("99px")).toBeNull();

  expect(sanitizeTextStyle("font-size: 20px")).toEqual({ fontSize: "1.25rem" });
  expect(sanitizeTextStyle("font-size: 1.5rem")).toEqual({ fontSize: "1.5rem" });
  expect(sanitizeTextStyle("font-size: 99rem")).toEqual({});
});

test("noteColorToCss uses semantic CSS variables without raw hex literals", () => {
  expect(noteColorToCss("default")).toBeNull();
  for (const color of NOTE_COLORS) {
    if (color === "default") continue;
    const cssValue = noteColorToCss(color);
    expect(cssValue).toStartWith("var(--color-utility-");
    expect(cssToNoteColor(cssValue)).toBe(color);
    expect(sanitizeTextStyle(`color: ${cssValue}`)).toEqual({ color: cssValue! });
  }
});
