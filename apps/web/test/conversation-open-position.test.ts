import { describe, expect, test } from "bun:test";

import {
  conversationOpenPosition,
  unreadBoundary,
} from "#src/features/conversations/conversation-open-position";

const messages = [
  { id: "m-1", sequence: 1 },
  { id: "m-2", sequence: 2 },
  { id: "m-3", sequence: 3 },
];

describe("unreadBoundary", () => {
  test("is the oldest message past the read cursor", () => {
    expect(unreadBoundary(messages, 1, undefined)).toEqual({ id: "m-2", sequence: 2 });
  });

  test("is absent once the cursor has caught up with the newest message", () => {
    expect(unreadBoundary(messages, 3, undefined)).toBeUndefined();
  });

  test("is absent without a cursor, so a pane opened for the first time lands at the latest", () => {
    expect(unreadBoundary(messages, undefined, undefined)).toBeUndefined();
  });

  test("is the first message when the cursor predates the whole page", () => {
    expect(unreadBoundary(messages, 0, undefined)).toEqual({ id: "m-1", sequence: 1 });
  });

  test("is absent in an empty pane", () => {
    expect(unreadBoundary([], 0, undefined)).toBeUndefined();
  });

  // Thread replies carry the channel's own sequence numbers, so a thread cursor is compared
  // against the same ordering; only the cursor's source differs.
  test("reads a thread's replies against that thread's own cursor", () => {
    const replies = [
      { id: "r-10", sequence: 10 },
      { id: "r-14", sequence: 14 },
    ];
    expect(unreadBoundary(replies, 10, undefined)).toEqual({ id: "r-14", sequence: 14 });
  });

  // As the server counts unread (`HUMAN_UNREAD_MESSAGE_SQL`), and as Activity picks the reply it
  // opens at (task #358).
  test("skips the viewer's own messages and system notices past the cursor", () => {
    const replies = [
      { id: "r-11", sequence: 11, senderMemberId: "viewer" },
      { id: "r-12", sequence: 12, senderMemberId: null },
      { id: "r-13", sequence: 13, senderMemberId: "agent" },
    ];
    expect(unreadBoundary(replies, 10, "viewer")).toMatchObject({ id: "r-13" });
    expect(unreadBoundary(replies.slice(0, 2), 10, "viewer")).toBeUndefined();
  });
});

describe("conversationOpenPosition", () => {
  const boundary = { id: "m-2", sequence: 2 };

  test("lands on the oldest unread boundary", () => {
    expect(conversationOpenPosition(boundary)).toBe("m-2");
  });

  test("lands at the latest when every message is read", () => {
    expect(conversationOpenPosition(undefined)).toBeUndefined();
  });
});
