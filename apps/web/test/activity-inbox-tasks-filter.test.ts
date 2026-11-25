import { expect, test } from "bun:test";
import {
  ACTIVITY_INBOX_FILTERS,
  activityInboxPageSchema,
} from "#src/features/inbox/activity-inbox.schemas";
import { projectPendingActivityCompletions } from "#src/features/inbox/activity-inbox-queries";
import { activityPageSql } from "#src/server/inbox/activity-inbox-page-sql.server";
import { artifactActivityPageSql } from "#src/server/artifacts/artifact-activity.server";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

test("ACTIVITY_INBOX_FILTERS places tasks before artifacts and schema accepts it", () => {
  expect(ACTIVITY_INBOX_FILTERS).toEqual(["all", "unread", "mentions", "tasks", "artifacts"]);
  expect(activityInboxPageSchema.parse({ filter: "tasks" })).toEqual({ filter: "tasks" });
});

test("activityPageSql filters to task items and computes unreadTaskItemCount", () => {
  const query = activityPageSql(WORKSPACE_ID, USER_ID, { filter: "tasks", limit: 30 });
  expect(query.sql).toContain('WHERE items."pastDone" AND items."taskBoardId" IS NOT NULL');
  expect(query.sql).toContain(
    'COUNT(*) FILTER (WHERE items."pastDone" AND items."hasUnread" AND items."taskBoardId" IS NOT NULL)',
  );
  expect(query.sql).toContain('AS "unreadTaskItemCount"');
  expect(query.sql).not.toContain('SELECT TRUE AS "isPin"');
});

test("artifactActivityPageSql excludes artifact rows when filter is tasks", () => {
  const query = artifactActivityPageSql(WORKSPACE_ID, USER_ID, { filter: "tasks", limit: 30 });
  expect(query.sql).toContain("WHERE FALSE AND");
});

test("projectPendingActivityCompletions decrements unreadTaskItemCount only for unread tasks", () => {
  const taskItem = {
    key: "conversation:t1",
    unreadCount: 2,
    unreadMention: false,
    task: { boardId: "b1", number: 12, title: "Ship tasks tab", conversationId: "t1" },
  };
  const readTaskItem = {
    key: "conversation:t2",
    unreadCount: 0,
    unreadMention: false,
    task: { boardId: "b1", number: 13, title: "Read task", conversationId: "t2" },
  };
  const channelItem = {
    key: "conversation:c1",
    unreadCount: 1,
    unreadMention: false,
    task: null,
  };
  const artifactItem = {
    key: "artifact:a1",
    unreadCount: 1,
    unreadMention: false,
  };

  const data = {
    pages: [
      {
        items: [taskItem, readTaskItem, channelItem, artifactItem],
        unreadItemCount: 3,
        unreadMentionItemCount: 0,
        unreadTaskItemCount: 1,
        unreadArtifactItemCount: 1,
        activeItemCount: 4,
      },
    ],
    pageParams: [undefined],
  };

  const afterChannel = projectPendingActivityCompletions(data, [channelItem]);
  expect(afterChannel.pages[0]?.unreadTaskItemCount).toBe(1);

  const afterArtifact = projectPendingActivityCompletions(afterChannel, [artifactItem]);
  expect(afterArtifact.pages[0]?.unreadTaskItemCount).toBe(1);

  const afterReadTask = projectPendingActivityCompletions(afterArtifact, [readTaskItem]);
  expect(afterReadTask.pages[0]?.unreadTaskItemCount).toBe(1);

  const afterUnreadTask = projectPendingActivityCompletions(afterReadTask, [taskItem]);
  expect(afterUnreadTask.pages[0]?.unreadTaskItemCount).toBe(0);
});
