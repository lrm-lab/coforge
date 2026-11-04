import { expect, test } from "bun:test";
import {
  hostedConversationOpenParam,
  parseHostedConversation,
} from "#src/features/conversations/conversation-page-search";
import {
  activityChatLink,
  activityOpenTarget,
  waitingChoiceTarget,
} from "#src/features/inbox/activity-open-target";
import type { WaitingChoiceCard } from "#src/server/conversations/waiting-choice-cards.server";
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

test("a comment on a file opens its conversation at the file's message, with the file's review at the comment", () => {
  const comment = item({
    latest: { id: "comment" } as ActivityInboxItem["latest"],
    attachmentComment: {
      attachmentId: "file",
      fileName: "review.txt",
      threadRootId: null,
      sourceMessageId: "source",
    },
  });
  const target = activityOpenTarget(comment);
  expect(target).toEqual({
    kind: "channel",
    id: "channel",
    messageId: "source",
    attachmentId: "file",
    commentId: "comment",
  });
  // Chat's link carries the same review in its address.
  expect(activityChatLink("acme", target).search).toEqual({
    message: "source",
    task: undefined,
    file: "file",
    comment: "comment",
  });
});

test("a reply to a comment opens at the comment it answers, the one the comments list shows", () => {
  const reply = item({
    latest: { id: "reply" } as ActivityInboxItem["latest"],
    attachmentComment: {
      attachmentId: "file",
      fileName: "review.txt",
      threadRootId: "root-comment",
      sourceMessageId: null,
    },
  });
  expect(activityOpenTarget(reply)).toEqual({
    kind: "channel",
    id: "channel",
    attachmentId: "file",
    commentId: "root-comment",
  });
});

/** A waiting choice card in a channel: only what `waitingChoiceTarget` reads. */
function card(overrides: Partial<WaitingChoiceCard>): WaitingChoiceCard {
  return {
    messageId: "card",
    conversationId: "conversation",
    channel: { name: "general", visibility: "public" },
    threadRootId: null,
    task: null,
    ...overrides,
  } as WaitingChoiceCard;
}

test("a waiting choice card opens at the card, in its channel or direct conversation", () => {
  expect(waitingChoiceTarget(card({}))).toEqual({
    kind: "channel",
    id: "conversation",
    messageId: "card",
  });
  expect(waitingChoiceTarget(card({ channel: null }))).toEqual({
    kind: "dm",
    id: "conversation",
    messageId: "card",
  });
});

test("a waiting choice card posted in a thread opens that thread alone, at the card", () => {
  expect(waitingChoiceTarget(card({ threadRootId: "root" }))).toEqual({
    kind: "channel",
    id: "conversation",
    messageId: "root",
    threadRootId: "root",
    threadReplyId: "card",
    threadAlone: true,
  });
});

test("a waiting choice card in a Task's conversation opens the Task's popup alone", () => {
  expect(
    waitingChoiceTarget(
      card({ channel: null, task: { conversationId: "channel", number: 7, channel: null } }),
    ),
  ).toEqual({ kind: "channel", id: "channel", task: 7, taskAlone: true });
});

test("a Task card opens the Task's popup alone, not its channel's chat (Frank, 11-04)", () => {
  const task = item({ task: { number: 4 } as ActivityInboxItem["task"] });
  const target = activityOpenTarget(task);
  expect(target).toEqual({
    kind: "channel",
    id: task.place.conversationId,
    task: 4,
    taskAlone: true,
  });
  // Its address says so, and reads back the same.
  const open = hostedConversationOpenParam(target);
  expect(open).toBe(`task:channel:${task.place.conversationId}`);
  expect(parseHostedConversation(open)?.taskAlone).toBe(true);
});
