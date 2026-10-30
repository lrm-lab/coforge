import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_COMMENTS_COLUMN as COMMENTS,
  CONVERSATION_LIST_BOOT,
  CONVERSATION_LIST_COLUMN as CHAT,
  LIST_COLUMN as LIST,
  clampListWidth,
  dragListWidth,
  keyListWidth,
  parseListWidth,
} from "./conversation-list-width";

const key = (key: string, extra: Partial<Parameters<typeof keyListWidth>[1]> = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...extra,
});

describe("list column width", () => {
  test("clamps to the column's range and ignores garbage", () => {
    expect(clampListWidth(CHAT, 100)).toBe(200);
    expect(clampListWidth(CHAT, 999)).toBe(400);
    expect(clampListWidth(LIST, 100)).toBe(240);
    expect(clampListWidth(LIST, 999)).toBe(640);
    expect(parseListWidth(CHAT, "350")).toBe(350);
    expect(parseListWidth(CHAT, "50")).toBe(200);
    expect(parseListWidth(LIST, "500")).toBe(500);
    expect(parseListWidth(CHAT, "abc")).toBeUndefined();
    expect(parseListWidth(CHAT, "")).toBeUndefined();
    expect(parseListWidth(CHAT, null)).toBeUndefined();
    expect(parseListWidth(CHAT, "-5")).toBeUndefined();
  });

  test("drag is continuous and clamped", () => {
    expect(dragListWidth(CHAT, 288, 300, 310.5)).toBe(298.5);
    expect(dragListWidth(CHAT, 288, 300, 100)).toBe(200);
    expect(dragListWidth(CHAT, 288, 300, 500)).toBe(400);
    expect(dragListWidth(LIST, 380, 300, 500)).toBe(580);
    expect(dragListWidth(LIST, 380, 300, 900)).toBe(640);
  });

  test("keys step, jump, and stay clamped", () => {
    expect(keyListWidth(CHAT, key("ArrowRight"), 288)).toBe(304);
    expect(keyListWidth(CHAT, key("ArrowLeft"), 288)).toBe(272);
    expect(keyListWidth(CHAT, key("ArrowRight", { shiftKey: true }), 288)).toBe(352);
    expect(keyListWidth(CHAT, key("ArrowRight", { shiftKey: true }), 380)).toBe(400);
    expect(keyListWidth(CHAT, key("ArrowLeft"), 205)).toBe(200);
    expect(keyListWidth(CHAT, key("Home"), 288)).toBe(200);
    expect(keyListWidth(CHAT, key("End"), 288)).toBe(400);
    expect(keyListWidth(LIST, key("Home"), 380)).toBe(240);
    expect(keyListWidth(LIST, key("End"), 380)).toBe(640);
    expect(keyListWidth(CHAT, key("Enter"), 288)).toBeUndefined();
    expect(keyListWidth(CHAT, key("ArrowLeft", { metaKey: true }), 288)).toBeUndefined();
  });

  test("boot script sets each column's stored width, clamped, and ignores garbage", () => {
    const run = (stored: Record<string, string>) => {
      const props: Record<string, string> = {};
      const documentElement = {
        style: { setProperty: (name: string, value: string) => (props[name] = value) },
      };
      new Function("localStorage", "document", CONVERSATION_LIST_BOOT)(
        { getItem: (name: string) => stored[name] ?? null },
        { documentElement },
      );
      return props;
    };
    expect(run({ "coforge-conversation-list-width": "350" })).toEqual({
      "--conversation-list-width": "350px",
    });
    expect(run({ "coforge-conversation-list-width": "9000" })).toEqual({
      "--conversation-list-width": "400px",
    });
    expect(
      run({ "coforge-list-column-width": "500", "coforge-conversation-list-width": "junk" }),
    ).toEqual({
      "--list-column-width": "500px",
    });
    expect(run({ "coforge-list-column-width": "100" })).toEqual({ "--list-column-width": "240px" });
    expect(run({})).toEqual({});
  });

  test("a column dragged by its left edge widens leftward, by pointer and by arrow key", () => {
    expect(dragListWidth(COMMENTS, 320, 1000, 940)).toBe(380);
    expect(dragListWidth(COMMENTS, 320, 1000, 1040)).toBe(280);
    expect(keyListWidth(COMMENTS, key("ArrowLeft"), 320)).toBe(336);
    expect(keyListWidth(COMMENTS, key("ArrowRight"), 320)).toBe(304);
    expect(dragListWidth(CHAT, 288, 100, 140)).toBe(328);
  });

  test("the boot script restores the comments panel's kept width", () => {
    expect(CONVERSATION_LIST_BOOT).toContain(COMMENTS.key);
    expect(CONVERSATION_LIST_BOOT).toContain(COMMENTS.property);
  });
});
