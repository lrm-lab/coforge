import { expect, test } from "bun:test";
import { readersAmong } from "#src/server/db/repositories/attachment-comment-recipients.repositories.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";

test("readersAmong checks a direct conversation once for all viewers", async () => {
  const conversationFindFirst = async () => {
    throw new Error("direct conversation visibility must not query once per viewer");
  };
  const db = {
    attachment: {
      findUnique: async () => ({
        workspaceId: "workspace-1",
        fileName: "review.txt",
        contentType: "text/plain",
        sizeBytes: 12,
        conversationId: "conversation-1",
        messageId: "message-1",
        commentThread: null,
        conversation: {
          directKey: "user:user-1|user:user-2",
          channelName: null,
          visibility: "private",
          kind: null,
          hiddenFromWorkspaceAt: null,
          archivedAt: null,
          members: [
            { userId: "user-1", agentId: null, leftAt: null, agent: null },
            { userId: "user-2", agentId: null, leftAt: null, agent: null },
          ],
        },
      }),
    },
    workspaceMembership: {
      findMany: async () => [{ userId: "user-1" }, { userId: "user-2" }],
    },
    agent: { findMany: async () => [] },
    conversation: { findFirst: conversationFindFirst },
  } as unknown as DatabaseScope;

  const readers = await readersAmong(
    db,
    [
      { workspaceId: "workspace-1", userId: "user-1" },
      { workspaceId: "workspace-1", userId: "user-2" },
    ],
    "attachment-1",
  );
  expect(readers).toEqual(new Set(["user:user-1", "user:user-2"]));
});
