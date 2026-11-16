import { describe, expect, test } from "bun:test";
import { shouldExitOnEscape } from "./conversation-focus-model";

const escape = (extra: Partial<Parameters<typeof shouldExitOnEscape>[0]> = {}) => ({
  key: "Escape",
  defaultPrevented: false,
  isComposing: false,
  keyCode: 27,
  ...extra,
});
const none = () => false;

describe("shouldExitOnEscape", () => {
  test("a plain Esc leaves focus", () => {
    expect(shouldExitOnEscape(escape(), none)).toBe(true);
  });

  test("other keys do not, and do not look for overlays", () => {
    let looked = false;
    const overlay = () => ((looked = true), false);
    expect(shouldExitOnEscape(escape({ key: "Enter" }), overlay)).toBe(false);
    expect(looked).toBe(false);
  });

  test("an Esc already handled is left alone", () => {
    expect(shouldExitOnEscape(escape({ defaultPrevented: true }), none)).toBe(false);
  });

  test("an open dialog, menu or popover keeps its Esc", () => {
    expect(shouldExitOnEscape(escape(), () => true)).toBe(false);
  });

  test("an input method composing keeps its Esc, also as Safari reports it", () => {
    expect(shouldExitOnEscape(escape({ isComposing: true }), none)).toBe(false);
    expect(shouldExitOnEscape(escape({ keyCode: 229 }), none)).toBe(false);
  });
});
