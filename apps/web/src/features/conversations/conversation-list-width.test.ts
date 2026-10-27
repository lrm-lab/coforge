import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_LIST_BOOT,
  clampListWidth,
  dragListWidth,
  isListToggleShortcut,
  keyListWidth,
  parseListWidth,
} from "./conversation-list-width";

const key = (key: string, extra: Partial<Parameters<typeof keyListWidth>[0]> = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...extra,
});

describe("conversation list width", () => {
  test("clamps to the range and ignores garbage", () => {
    expect(clampListWidth(100)).toBe(200);
    expect(clampListWidth(999)).toBe(400);
    expect(parseListWidth("350")).toBe(350);
    expect(parseListWidth("50")).toBe(200);
    expect(parseListWidth("abc")).toBeUndefined();
    expect(parseListWidth("")).toBeUndefined();
    expect(parseListWidth(null)).toBeUndefined();
    expect(parseListWidth("-5")).toBeUndefined();
  });

  test("drag is continuous, clamped, and collapses past the snap distance", () => {
    expect(dragListWidth(288, 300, 310.5)).toEqual({ width: 298.5, collapsed: false });
    expect(dragListWidth(288, 300, 190)).toEqual({ width: 200, collapsed: false });
    expect(dragListWidth(288, 300, 500)).toEqual({ width: 400, collapsed: false });
    expect(dragListWidth(288, 300, 172).collapsed).toBe(false);
    expect(dragListWidth(288, 300, 171).collapsed).toBe(true);
  });

  test("keys step, jump, and stay clamped", () => {
    expect(keyListWidth(key("ArrowRight"), 288)).toBe(304);
    expect(keyListWidth(key("ArrowLeft"), 288)).toBe(272);
    expect(keyListWidth(key("ArrowRight", { shiftKey: true }), 288)).toBe(352);
    expect(keyListWidth(key("ArrowRight", { shiftKey: true }), 380)).toBe(400);
    expect(keyListWidth(key("ArrowLeft"), 205)).toBe(200);
    expect(keyListWidth(key("Home"), 288)).toBe(200);
    expect(keyListWidth(key("End"), 288)).toBe(400);
    expect(keyListWidth(key("Enter"), 288)).toBeUndefined();
    expect(keyListWidth(key("ArrowLeft", { metaKey: true }), 288)).toBeUndefined();
  });

  test("shortcut is Cmd+\\ on Apple, Ctrl+\\ elsewhere", () => {
    const press = (extra: Record<string, unknown> = {}) => ({
      key: "\\",
      code: "Backslash",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      ...extra,
    });
    expect(isListToggleShortcut(press({ metaKey: true }), true)).toBe(true);
    expect(isListToggleShortcut(press({ ctrlKey: true }), true)).toBe(false);
    expect(isListToggleShortcut(press({ ctrlKey: true }), false)).toBe(true);
    expect(isListToggleShortcut(press({ metaKey: true }), false)).toBe(false);
    expect(isListToggleShortcut(press({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isListToggleShortcut(press({ ctrlKey: true, repeat: true }), false)).toBe(false);
    expect(
      isListToggleShortcut(press({ ctrlKey: true, key: "\\", code: "IntlBackslash" }), false),
    ).toBe(true);
  });

  test("boot script clamps a stored width and ignores garbage", () => {
    const run = (stored: Record<string, string>) => {
      const classes = new Set<string>();
      const props: Record<string, string> = {};
      const documentElement = {
        classList: { add: (name: string) => classes.add(name) },
        style: { setProperty: (name: string, value: string) => (props[name] = value) },
      };
      new Function("localStorage", "document", CONVERSATION_LIST_BOOT)(
        { getItem: (name: string) => stored[name] ?? null },
        { documentElement },
      );
      return { classes: [...classes], props };
    };
    expect(run({ "coforge-conversation-list-width": "350" }).props).toEqual({
      "--conversation-list-width": "350px",
    });
    expect(run({ "coforge-conversation-list-width": "9000" }).props).toEqual({
      "--conversation-list-width": "400px",
    });
    expect(run({ "coforge-conversation-list-width": "junk" }).props).toEqual({});
    expect(run({}).props).toEqual({});
    expect(run({ "coforge-conversation-list-visible": "hide" }).classes).toEqual([
      "conversation-list-collapsed",
    ]);
  });
});
