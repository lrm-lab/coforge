import { expect, test } from "bun:test";
import { activityRowPlace } from "#src/features/inbox/activity-row-place";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

const comment = {
  attachmentId: "file",
  fileName: "chart.png",
  threadRootId: null,
  sourceMessageId: "message",
};
const thread = { root: { id: "root" } } as unknown as ActivityInboxItem["thread"];

test("a comment on a file names the file, though it starts no thread (QA on staging, task #269)", () => {
  expect(activityRowPlace({ attachmentComment: comment, thread: null, task: null })).toEqual({
    kind: "attachment",
    fileName: "chart.png",
  });
});

test("a reply to a comment names the file, not the conversation", () => {
  expect(activityRowPlace({ attachmentComment: comment, thread, task: null })).toEqual({
    kind: "attachment",
    fileName: "chart.png",
  });
});

test("a thread or a Task names its conversation; a conversation's own row names nothing", () => {
  expect(activityRowPlace({ attachmentComment: null, thread, task: null })).toEqual({
    kind: "conversation",
  });
  expect(
    activityRowPlace({
      attachmentComment: null,
      thread: null,
      task: { boardId: "board", number: 3, title: "Ship", conversationId: "task" },
    }),
  ).toEqual({ kind: "conversation" });
  expect(activityRowPlace({ attachmentComment: null, thread: null, task: null })).toBeUndefined();
});
