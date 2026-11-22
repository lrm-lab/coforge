import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_COMMENTS_COLUMN as COMMENTS,
  CONVERSATION_LIST_BOOT,
  CONVERSATION_LIST_COLUMN as CHAT,
  LIST_COLUMN as LIST,
  SIDEBAR_COLUMN,
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
  test("clamps rem bounds, migrates legacy px values, and ignores garbage", () => {
    expect(clampListWidth(CHAT, 8)).toBe(12.5);
    expect(clampListWidth(CHAT, 50)).toBe(25);
    expect(clampListWidth(LIST, 10)).toBe(18);
    expect(clampListWidth(LIST, 60)).toBe(40);
    expect(parseListWidth(CHAT, "21.875")).toBe(21.875);
    expect(parseListWidth(CHAT, "8")).toBe(12.5);
    expect(parseListWidth(LIST, "31.25")).toBe(31.25);
    expect(parseListWidth(CHAT, "350")).toBe(21.875);
    expect(parseListWidth(CHAT, "abc")).toBeUndefined();
    expect(parseListWidth(CHAT, "")).toBeUndefined();
    expect(parseListWidth(CHAT, null)).toBeUndefined();
    expect(parseListWidth(CHAT, "-5")).toBeUndefined();
  });

  test("drag is continuous and clamped in rem", () => {
    expect(dragListWidth(CHAT, 18, 18.75, 19.5)).toBe(18.75);
    expect(dragListWidth(CHAT, 18, 18.75, 5)).toBe(12.5);
    expect(dragListWidth(CHAT, 18, 18.75, 32)).toBe(25);
    expect(dragListWidth(LIST, 23.75, 18.75, 31.25)).toBe(36.25);
    expect(dragListWidth(LIST, 23.75, 18.75, 60)).toBe(40);
  });

  test("keys step, jump, and stay clamped in rem", () => {
    expect(keyListWidth(CHAT, key("ArrowRight"), 18)).toBe(19);
    expect(keyListWidth(CHAT, key("ArrowLeft"), 18)).toBe(17);
    expect(keyListWidth(CHAT, key("ArrowRight", { shiftKey: true }), 18)).toBe(22);
    expect(keyListWidth(CHAT, key("ArrowRight", { shiftKey: true }), 23.75)).toBe(25);
    expect(keyListWidth(CHAT, key("ArrowLeft"), 13)).toBe(12.5);
    expect(keyListWidth(CHAT, key("Home"), 18)).toBe(12.5);
    expect(keyListWidth(CHAT, key("End"), 18)).toBe(25);
    expect(keyListWidth(LIST, key("Home"), 23.75)).toBe(18);
    expect(keyListWidth(LIST, key("End"), 23.75)).toBe(40);
    expect(keyListWidth(CHAT, key("Enter"), 18)).toBeUndefined();
    expect(keyListWidth(CHAT, key("ArrowLeft", { metaKey: true }), 18)).toBeUndefined();
  });

  test("boot script sets each column's stored width in rem, clamped, and ignores garbage", () => {
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
    expect(run({ "coforge-conversation-list-width": "21.875" })).toEqual({
      "--conversation-list-width": "21.875rem",
    });
    expect(run({ "coforge-conversation-list-width": "350" })).toEqual({
      "--conversation-list-width": "21.875rem",
    });
    expect(run({ "coforge-conversation-list-width": "9000" })).toEqual({
      "--conversation-list-width": "25rem",
    });
    expect(
      run({ "coforge-list-column-width": "31.25", "coforge-conversation-list-width": "junk" }),
    ).toEqual({
      "--list-column-width": "31.25rem",
    });
    expect(run({ "coforge-list-column-width": "100" })).toEqual({ "--list-column-width": "18rem" });
    expect(run({})).toEqual({});
  });

  test("a column dragged by its left edge widens leftward, by pointer and by arrow key", () => {
    expect(dragListWidth(COMMENTS, 20, 62.5, 58.75)).toBe(23.75);
    expect(dragListWidth(COMMENTS, 20, 62.5, 65)).toBe(17.5);
    expect(keyListWidth(COMMENTS, key("ArrowLeft"), 20)).toBe(21);
    expect(keyListWidth(COMMENTS, key("ArrowRight"), 20)).toBe(19);
    expect(dragListWidth(CHAT, 18, 6.25, 8.75)).toBe(20.5);
  });

  test("the boot script restores the comments panel's kept width", () => {
    expect(CONVERSATION_LIST_BOOT).toContain(COMMENTS.key);
    expect(CONVERSATION_LIST_BOOT).toContain(COMMENTS.property);
  });

  test("each list starts at its default, which double-click resets to, inside its range", () => {
    expect([CHAT.defaultWidth, LIST.defaultWidth]).toEqual([18, 23.75]);
    for (const column of [CHAT, LIST, COMMENTS])
      expect(clampListWidth(column, column.defaultWidth)).toBe(column.defaultWidth);
    expect(dragListWidth(CHAT, 18, 18.75, 18.75 + 2.5 - 18)).toBe(12.5);
    expect(dragListWidth(LIST, 23.75, 18.75, 18.75 + 2.5 - 23.75)).toBe(18);
    expect(dragListWidth(CHAT, 18, 18.75, 18.75 + 20.625 - 18)).toBe(20.625);
  });

  test("the Activity list's keys step by 1 rem from its default and jump to its ends", () => {
    expect(keyListWidth(LIST, key("ArrowRight"), 23.75)).toBe(24.75);
    expect(keyListWidth(LIST, key("ArrowLeft"), 18.25)).toBe(18);
    expect(keyListWidth(LIST, key("ArrowRight"), 40)).toBe(40);
  });

  test("the sidebar never goes narrower than its default and its kept width is restored at boot", () => {
    expect(SIDEBAR_COLUMN.min).toBe(SIDEBAR_COLUMN.defaultWidth);
    expect(dragListWidth(SIDEBAR_COLUMN, 15, 15, 6)).toBe(15);
    expect(dragListWidth(SIDEBAR_COLUMN, 15, 15, 35)).toBe(20);
    expect(CONVERSATION_LIST_BOOT).toContain(SIDEBAR_COLUMN.property);
  });

  test("mirrors pointer drag and arrow keys in RTL for both inline-end and inline-start handles", () => {
    expect(dragListWidth(CHAT, 18, 20, 17, true)).toBe(21);
    expect(dragListWidth(CHAT, 18, 20, 23, true)).toBe(15);
    expect(keyListWidth(CHAT, key("ArrowLeft"), 18, true)).toBe(19);
    expect(keyListWidth(CHAT, key("ArrowRight"), 18, true)).toBe(17);
    expect(dragListWidth(COMMENTS, 20, 20, 23.75, true)).toBe(23.75);
    expect(dragListWidth(COMMENTS, 20, 20, 18, true)).toBe(18);
    expect(keyListWidth(COMMENTS, key("ArrowRight"), 20, true)).toBe(21);
    expect(keyListWidth(COMMENTS, key("ArrowLeft"), 20, true)).toBe(19);
  });
});
