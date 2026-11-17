/** The one Task order every list shares, and the priority levels it ranks by (task #13). */

/** A Task's priority, highest first (Linear's five levels); `none` is the stored level of a
 * Task nobody prioritized — a create or update may name only the four below. */
export const TASK_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** The priorities a command may set: every level but `none` (task #12). */
export const TASK_PRIORITY_LEVELS = ["urgent", "high", "medium", "low"] as const;
export type TaskPriorityLevel = (typeof TASK_PRIORITY_LEVELS)[number];

/** Where a priority sorts: 0 for `urgent`, and so on. A missing one (an older server) is `none`. */
export const taskPriorityRank = (priority: TaskPriority | undefined) =>
  TASK_PRIORITIES.indexOf(priority ?? "none");

/** A due instant this close reads as due soon (task #13). */
export const TASK_DUE_SOON_MS = 24 * 60 * 60 * 1000;
export type TaskDueState = "overdue" | "due_soon" | null;

const orderTime = (at: string | Date) => (typeof at === "string" ? Date.parse(at) : at.getTime());

/** How a due instant reads at `now`: `overdue` once it has passed, `due_soon` within a day of
 * it, null when it is further out or the Task has none. Computed on read, never stored. */
export function taskDueState(
  dueAt: string | Date | null | undefined,
  now: number = Date.now(),
): TaskDueState {
  if (dueAt === null || dueAt === undefined || dueAt === "") return null;
  const at = orderTime(dueAt);
  if (Number.isNaN(at)) return null;
  if (at < now) return "overdue";
  if (at <= now + TASK_DUE_SOON_MS) return "due_soon";
  return null;
}

/** The one Task order every list shares (task #13): highest priority first, the earliest due
 * next (a Task with no due waits behind every dated one of its level), then oldest first, id
 * for stability. */
export function compareTaskOrder(
  left: {
    id: string;
    priority?: TaskPriority;
    dueAt?: string | Date | null;
    createdAt: string | Date;
  },
  right: {
    id: string;
    priority?: TaskPriority;
    dueAt?: string | Date | null;
    createdAt: string | Date;
  },
): number {
  const due = (task: { dueAt?: string | Date | null }) =>
    task.dueAt === null || task.dueAt === undefined || task.dueAt === ""
      ? Number.POSITIVE_INFINITY
      : orderTime(task.dueAt);
  return (
    taskPriorityRank(left.priority) - taskPriorityRank(right.priority) ||
    due(left) - due(right) ||
    orderTime(left.createdAt) - orderTime(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
