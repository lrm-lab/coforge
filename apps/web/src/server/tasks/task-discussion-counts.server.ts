import type { PrismaClient } from "#src/generated/prisma/client";
import { loadTaskRelations, relationsOf } from "./task-relations.server";
import type {
  DiscussionCounts,
  TaskReader,
  TaskViewExtras,
  TaskViewSource,
} from "./task-view.server";

/**
 * The replies in each task's own conversation, the files sent there, and the replies in the thread
 * it had before (the thread under its source message), for the tasks one read returns: grouped
 * counts bounded by those tasks' ids and the Workspace. They are not part of
 * `taskSelection`: counting through the relation groups every message of the table, once per
 * read. Server notices are not replies; an unsent upload (no message yet) is not a file.
 */
export async function discussionCounts(
  db: PrismaClient,
  workspaceId: string,
  tasks: readonly Pick<TaskViewSource, "id" | "messageId" | "discussionConversationId">[],
): Promise<Map<string, DiscussionCounts>> {
  if (!tasks.length) return new Map();
  const conversations = tasks.flatMap((task) =>
    task.discussionConversationId ? [task.discussionConversationId] : [],
  );
  const roots = tasks.flatMap((task) => (task.messageId ? [task.messageId] : []));
  const rows =
    conversations.length || roots.length
      ? await db.$queryRaw<{ kind: "own" | "earlier" | "files"; id: string; count: bigint }[]>`
          SELECT 'own' AS kind, "conversationId"::text AS id, COUNT(*) AS count FROM "messages"
          WHERE "workspaceId" = ${workspaceId}::uuid
            AND "conversationId" = ANY(${conversations}::uuid[]) AND "senderMemberId" IS NOT NULL
          GROUP BY "conversationId"
          UNION ALL
          SELECT 'earlier', "threadRootId"::text, COUNT(*) FROM "messages"
          WHERE "workspaceId" = ${workspaceId}::uuid
            AND "threadRootId" = ANY(${roots}::uuid[]) AND "senderMemberId" IS NOT NULL
          GROUP BY "threadRootId"
          UNION ALL
          SELECT 'files', "conversationId"::text, COUNT(*) FROM "attachments"
          WHERE "workspaceId" = ${workspaceId}::uuid
            AND "conversationId" = ANY(${conversations}::uuid[]) AND "messageId" IS NOT NULL
          GROUP BY "conversationId"`
      : [];
  const ownBy = new Map<string, number>();
  const earlierBy = new Map<string, number>();
  const filesBy = new Map<string, number>();
  const counts = { own: ownBy, earlier: earlierBy, files: filesBy };
  for (const row of rows) counts[row.kind].set(row.id, Number(row.count));
  return new Map(
    tasks.map((task) => [
      task.id,
      {
        replyCount:
          (task.discussionConversationId && ownBy.get(task.discussionConversationId)) || 0,
        earlierReplies: (task.messageId && earlierBy.get(task.messageId)) || 0,
        fileCount:
          (task.discussionConversationId && filesBy.get(task.discussionConversationId)) || 0,
      },
    ]),
  );
}

/** `taskView` for each of `tasks`: discussions counted once and relations read once for the page. */
export async function viewsWithCounts<Task extends TaskViewSource, View>(
  db: PrismaClient,
  reader: TaskReader,
  workspaceId: string,
  tasks: readonly Task[],
  view: (task: Task, extras: TaskViewExtras) => View,
) {
  const [counts, relations] = await Promise.all([
    discussionCounts(db, workspaceId, tasks),
    loadTaskRelations(db, reader, tasks),
  ]);
  return tasks.map((task) =>
    view(task, { counts: counts.get(task.id), relations: relationsOf(relations, task.id) }),
  );
}
