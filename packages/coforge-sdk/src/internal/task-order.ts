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
