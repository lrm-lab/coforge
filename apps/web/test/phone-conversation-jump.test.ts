import { describe, expect, test } from "bun:test";

import {
  navigationRevealsConversation,
  type ConversationLocationSnapshot,
} from "#src/features/conversations/phone-conversation-jump";

const snap = (
  pathname: string,
  search: Record<string, unknown> = {},
  hash = "",
): ConversationLocationSnapshot => ({
  pathname,
  search,
  hash,
});

describe("navigationRevealsConversation", () => {
  test("reveals when navigating to a different pathname", () => {
    expect(navigationRevealsConversation(snap("/w/a/channel/1"), snap("/w/a/channel/2"))).toBe(
      true,
    );
  });

  test("reveals when jumping to a message on the same pathname", () => {
    expect(
      navigationRevealsConversation(
        snap("/w/a/channel/1"),
        snap("/w/a/channel/1", { message: "msg-1" }),
      ),
    ).toBe(true);
  });

  test("does not reveal when clearing the consumed message param", () => {
    expect(
      navigationRevealsConversation(
        snap("/w/a/channel/1", { message: "msg-1" }),
        snap("/w/a/channel/1", { message: undefined }),
      ),
    ).toBe(false);
  });

  test("reveals when opening a thread or jumping via hash on the same pathname", () => {
    expect(
      navigationRevealsConversation(
        snap("/w/a/channel/1"),
        snap("/w/a/channel/1", { threadRootId: "root-1", message: "root-1" }, "message-reply-1"),
      ),
    ).toBe(true);
    expect(
      navigationRevealsConversation(snap("/w/a/dm/1"), snap("/w/a/dm/1", {}, "message-dm-1")),
    ).toBe(true);
  });

  test("does not reveal when closing a thread or clearing hash", () => {
    expect(
      navigationRevealsConversation(
        snap("/w/a/channel/1", { threadRootId: "root-1" }, "message-reply-1"),
        snap("/w/a/channel/1", {}, ""),
      ),
    ).toBe(false);
  });

  test("reveals when opening a task and ignores closing it", () => {
    expect(
      navigationRevealsConversation(snap("/w/a/channel/1"), snap("/w/a/channel/1", { task: 4 })),
    ).toBe(true);
    expect(
      navigationRevealsConversation(snap("/w/a/channel/1", { task: 4 }), snap("/w/a/channel/1")),
    ).toBe(false);
  });

  test("does not reveal when location snapshot is unchanged", () => {
    expect(navigationRevealsConversation(snap("/w/a/dm/1"), snap("/w/a/dm/1"))).toBe(false);
  });
});
