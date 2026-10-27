import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_LIST_BOOT,
  clampListWidth,
  dragListWidth,
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

  test("drag is continuous and clamped", () => {
    expect(dragListWidth(288, 300, 310.5)).toBe(298.5);
    expect(dragListWidth(288, 300, 100)).toBe(200);
    expect(dragListWidth(288, 300, 500)).toBe(400);
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

  test("boot script clamps a stored width and ignores garbage", () => {
    const run = (stored: Record<string, string>) => {
      const props: Record<string, string> = {};
      const documentElement = {
        style: { setProperty: (name: string, value: string) => (props[name] = value) },
      };
      new Function("localStorage", "document", CONVERSATION_LIST_BOOT)(
        { getItem: (name: string) => stored[name] ?? null },
        { documentElement },
      );
      return { props };
    };
    expect(run({ "coforge-conversation-list-width": "350" }).props).toEqual({
      "--conversation-list-width": "350px",
    });
    expect(run({ "coforge-conversation-list-width": "9000" }).props).toEqual({
      "--conversation-list-width": "400px",
    });
    expect(run({ "coforge-conversation-list-width": "junk" }).props).toEqual({});
    expect(run({}).props).toEqual({});
  });
});
