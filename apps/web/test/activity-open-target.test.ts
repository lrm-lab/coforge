import { expect, test } from "bun:test";
import { activityOpenTarget } from "#src/features/inbox/activity-open-target";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

/** A channel's Activity item: only what `activityOpenTarget` reads. */
function item(overrides: Partial<ActivityInboxItem>): ActivityInboxItem {
  return {
    place: { kind: "channel", conversationId: "channel" },
    thread: null,
    task: null,
    latest: { id: "latest" },
    mentionAction: null,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    ...overrides,
  } as unknown as ActivityInboxItem;
}

test("an item opens at its first unread message, ahead of a mention already read (task #358)", () => {
  expect(
    activityOpenTarget(item({ firstMentionMessageId: "old-mention", firstUnreadMessageId: "new" })),
  ).toMatchObject({ kind: "channel", id: "channel", messageId: "new" });
});

test("an unread mention below earlier unread messages opens at the first of them, under its divider", () => {
  expect(
    activityOpenTarget(
      item({ firstUnreadMessageId: "first-unread", firstMentionMessageId: "unread-mention" }),
    ).messageId,
  ).toBe("first-unread");
});

test("with nothing unread, an item that mentions the viewer opens at its first mention (#1129)", () => {
  expect(activityOpenTarget(item({ firstMentionMessageId: "old-mention" })).messageId).toBe(
    "old-mention",
  );
  expect(activityOpenTarget(item({})).messageId).toBe("latest");
});

test("a thread opens at its first unread reply, ahead of a mention already read", () => {
  const target = activityOpenTarget(
    item({
      thread: { root: { id: "root" } } as ActivityInboxItem["thread"],
      firstMentionMessageId: "old-reply",
      firstUnreadMessageId: "new-reply",
    }),
  );
  expect(target).toMatchObject({
    messageId: "root",
    threadRootId: "root",
    threadReplyId: "new-reply",
  });
});
