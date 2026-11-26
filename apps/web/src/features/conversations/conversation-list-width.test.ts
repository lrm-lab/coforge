import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_COMMENTS_COLUMN as COMMENTS,
  CONVERSATION_LIST_BOOT,
  CONVERSATION_LIST_COLUMN as CHAT,
  LIST_COLUMN as LIST,
  clampListWidth,
  parseListWidth,
} from "./conversation-list-width";

describe("list column width", () => {
  test("clamps rem bounds, migrates legacy px values, and ignores garbage", () => {
    expect(clampListWidth(CHAT, 8)).toBe(12.5);
    expect(clampListWidth(CHAT, 50)).toBe(25);
    expect(clampListWidth(LIST, 10)).toBe(18);
    expect(clampListWidth(LIST, 60)).toBe(40);
    expect(clampListWidth(COMMENTS, 10)).toBe(17.5);
    expect(clampListWidth(COMMENTS, 60)).toBe(35);
    expect(parseListWidth(CHAT, "21.875")).toBe(21.875);
    expect(parseListWidth(CHAT, "8")).toBe(12.5);
    expect(parseListWidth(LIST, "31.25")).toBe(31.25);
    expect(parseListWidth(CHAT, "350")).toBe(21.875);
    expect(parseListWidth(CHAT, "abc")).toBeUndefined();
    expect(parseListWidth(CHAT, "")).toBeUndefined();
    expect(parseListWidth(CHAT, null)).toBeUndefined();
    expect(parseListWidth(CHAT, "-5")).toBeUndefined();
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

  test("the boot script restores the comments panel's kept width", () => {
    expect(CONVERSATION_LIST_BOOT).toContain(COMMENTS.key);
    expect(CONVERSATION_LIST_BOOT).toContain(COMMENTS.property);
  });

  test("each list starts at its default inside its range and caps its share of the split", () => {
    expect([CHAT.defaultWidth, LIST.defaultWidth, COMMENTS.defaultWidth]).toEqual([18, 23.75, 20]);
    expect([CHAT.maxPct, LIST.maxPct, COMMENTS.maxPct]).toEqual([40, 50, 50]);
    for (const column of [CHAT, LIST, COMMENTS])
      expect(clampListWidth(column, column.defaultWidth)).toBe(column.defaultWidth);
  });
});
