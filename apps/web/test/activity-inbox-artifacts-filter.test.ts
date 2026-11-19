import { expect, test } from "bun:test";
import {
  ACTIVITY_INBOX_FILTERS,
  activityInboxPageSchema,
} from "#src/features/inbox/activity-inbox.schemas";
import { projectPendingActivityCompletions } from "#src/features/inbox/activity-inbox-queries";
import { activityPageSql } from "#src/server/inbox/activity-inbox-page-sql.server";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

test("ACTIVITY_INBOX_FILTERS includes artifacts and schema accepts it", () => {
  expect(ACTIVITY_INBOX_FILTERS).toContain("artifacts");
  expect(activityInboxPageSchema.parse({ filter: "artifacts" })).toEqual({ filter: "artifacts" });
});

test("activityPageSql filters out conversation rows when filter is artifacts", () => {
  const query = activityPageSql(WORKSPACE_ID, USER_ID, { filter: "artifacts", limit: 30 });
  expect(query.sql).toContain('WHERE items."pastDone" AND FALSE');
});

test("projectPendingActivityCompletions decrements unreadArtifactItemCount only for unread artifacts", () => {
  const data = {
    pages: [
      {
        items: [
          { key: "artifact:a1", unreadCount: 2, unreadMention: false },
          { key: "conversation:c1", unreadCount: 1, unreadMention: false },
        ],
        unreadItemCount: 2,
        unreadMentionItemCount: 0,
        unreadArtifactItemCount: 1,
        activeItemCount: 2,
      },
    ],
    pageParams: [undefined],
  };

  const afterConversation = projectPendingActivityCompletions(data, [
    { key: "conversation:c1", unreadCount: 1, unreadMention: false },
  ]);
  expect(afterConversation.pages[0]?.unreadArtifactItemCount).toBe(1);

  const afterArtifact = projectPendingActivityCompletions(afterConversation, [
    { key: "artifact:a1", unreadCount: 2, unreadMention: false },
  ]);
  expect(afterArtifact.pages[0]?.unreadArtifactItemCount).toBe(0);
});
