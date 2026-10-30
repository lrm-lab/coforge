import type { PrismaClient } from "#src/generated/prisma/client";
import { taskConversationsEnabled } from "./task-conversations-gate.server";
import type { DiscussionCounts, SelectedTask } from "./task-view.server";

/**
 * The replies in each task's own conversation, and in the thread it had before (the thread under
 * its source message), for the tasks one read returns: two grouped counts bounded by those tasks'
 * ids and the Workspace. They are not part of `taskSelection`: counting through the relation
 * groups every message of the table, once per read. Server notices are not replies.
 */
export async function discussionCounts(
  db: PrismaClient,
  workspaceId: string,
  tasks: readonly Pick<SelectedTask, "id" | "messageId" | "discussionConversationId">[],
): Promise<Map<string, DiscussionCounts>> {
  // Only a Workspace with task conversations has either to count.
  if (!tasks.length || !(await taskConversationsEnabled(db, { workspaceId }))) return new Map();
  const conversations = tasks.flatMap((task) =>
    task.discussionConversationId ? [task.discussionConversationId] : [],
  );
  const roots = tasks.flatMap((task) => (task.messageId ? [task.messageId] : []));
  const [own, earlier] = await Promise.all([
    conversations.length
      ? db.$queryRaw<{ id: string; count: bigint }[]>`
          SELECT "conversationId"::text AS id, COUNT(*) AS count FROM "messages"
          WHERE "workspaceId" = ${workspaceId}::uuid
            AND "conversationId" = ANY(${conversations}::uuid[]) AND "senderMemberId" IS NOT NULL
          GROUP BY "conversationId"`
      : [],
    roots.length
      ? db.$queryRaw<{ id: string; count: bigint }[]>`
          SELECT "threadRootId"::text AS id, COUNT(*) AS count FROM "messages"
          WHERE "workspaceId" = ${workspaceId}::uuid
            AND "threadRootId" = ANY(${roots}::uuid[]) AND "senderMemberId" IS NOT NULL
          GROUP BY "threadRootId"`
      : [],
  ]);
  const ownBy = new Map(own.map((row) => [row.id, Number(row.count)]));
  const earlierBy = new Map(earlier.map((row) => [row.id, Number(row.count)]));
  return new Map(
    tasks.map((task) => [
      task.id,
      {
        replyCount:
          (task.discussionConversationId && ownBy.get(task.discussionConversationId)) || 0,
        earlierReplies: (task.messageId && earlierBy.get(task.messageId)) || 0,
      },
    ]),
  );
}

/** `taskView` for each of `tasks`, counted once. */
export async function viewsWithCounts<Task extends SelectedTask, View>(
  db: PrismaClient,
  workspaceId: string,
  tasks: readonly Task[],
  view: (task: Task, counts: DiscussionCounts | undefined) => View,
) {
  const counts = await discussionCounts(db, workspaceId, tasks);
  return tasks.map((task) => view(task, counts.get(task.id)));
}
