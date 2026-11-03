import { taskPriorityRank, type TaskView } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { Member, Transaction } from "./task-board-ports.server";
import { isTaskManager } from "./task-assignees.server";

/** A priority that is not one of the five, or on an operation that takes none. */
export const TASK_PRIORITY_INVALID = "task_priority_invalid";
/** An Agent setting the priority of a Task it neither created nor coordinates the channel of. */
export const TASK_PRIORITY_DENIED = "task_priority_denied";

/**
 * Who sets a Task's priority: anyone who may speak in its conversation (the caller has resolved
 * them as a member), except that an Agent may only on a Task it created or in a channel it
 * coordinates. A Workspace owner or admin, an Agent with that role included, always may.
 */
export async function assertCanSetPriority(
  tx: Transaction,
  conversation: { conversationId: string; workspaceId: string },
  member: Member,
  task: { creator: { id: string } },
) {
  if (!member.agentId || task.creator.id === member.id) return;
  const coordinated = await tx.conversation.count({
    where: { id: conversation.conversationId, coordinatorAgentId: member.agentId },
  });
  if (coordinated > 0 || (await isTaskManager(tx, conversation.workspaceId, member))) return;
  throw new AppError("ACCESS_DENIED", {
    errorId: TASK_PRIORITY_DENIED,
    hint: "an Agent sets the priority only of a task it created, or in a channel it coordinates",
  });
}

/** Highest priority first; `tie` keeps a level's own order (oldest first). Stable. */
export function byPriority<T extends Pick<TaskView, "priority">>(
  tasks: T[],
  tie: (left: T, right: T) => number = () => 0,
): T[] {
  return tasks.sort(
    (left, right) =>
      taskPriorityRank(left.priority) - taskPriorityRank(right.priority) || tie(left, right),
  );
}
