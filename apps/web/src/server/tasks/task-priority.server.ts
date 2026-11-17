import { compareTaskOrder } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { Member, Transaction } from "./task-board-ports.server";
import { isTaskManager } from "./task-assignees.server";

/** A priority that is not one of the four levels (`urgent|high|medium|low`), or on an operation
 * that takes none — `none` itself is a stored level, never a choice (task #12). */
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

/** The one Task order every list shares (task #13): priority, then earliest due, then oldest.
 * Stable. */
export function byPriority<T extends Parameters<typeof compareTaskOrder>[0]>(tasks: T[]): T[] {
  return [...tasks].sort(compareTaskOrder);
}
