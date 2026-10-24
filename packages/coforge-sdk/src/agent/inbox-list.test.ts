import { expect, test } from "bun:test";
import { decodeAgentInboxListResponse } from "./inbox-list";

const response = (kind: unknown) => ({
  ok: true,
  view: "unread",
  items: [
    {
      kind,
      target: "#general:3f4b1fd4-aaaa",
      unread: 2,
      mentions: 0,
      latestAt: "2026-10-25T11:00:00.000Z",
      latestSenderName: "scout",
      lastReadSeq: 0,
    },
  ],
  totals: { conversations: 1, dms: 0, mentions: 0 },
  hasMore: false,
  nextBefore: null,
});

test("decodes an Inbox list whose items are a dm, a channel or a thread", () => {
  for (const kind of ["dm", "channel", "thread"] as const)
    expect(decodeAgentInboxListResponse(response(kind)).items[0]!.kind).toBe(kind);
});

test("refuses an item without a known kind", () => {
  for (const kind of [undefined, "group", 3])
    expect(() => decodeAgentInboxListResponse(response(kind))).toThrow(
      "invalid Agent inbox list response",
    );
});
