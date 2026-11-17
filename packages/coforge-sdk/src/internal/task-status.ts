export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;
export const TASK_READ_STATUSES = ["backlog", ...TASK_STATUSES] as const;
export type TaskStatus = (typeof TASK_READ_STATUSES)[number];
export const isTaskReadStatus = (value: string): value is TaskStatus =>
  (TASK_READ_STATUSES as readonly string[]).includes(value);

export const isTaskStatus = (value: string): value is TaskStatus =>
  (TASK_STATUSES as readonly string[]).includes(value);

export const ORDINARY_TASK_STATUS_MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ["todo", "in_progress", "closed"],
  todo: ["in_progress", "closed"],
  in_progress: ["todo", "in_review", "closed"],
  in_review: ["in_progress", "done", "closed"],
  done: ["todo", "in_progress", "in_review", "closed"],
  closed: ["todo"],
};

export function ordinaryTaskStatusMove(from: TaskStatus, to: TaskStatus): boolean {
  return to === from || ORDINARY_TASK_STATUS_MOVES[from].includes(to);
}

export function taskStatusMoveAllowed(
  from: TaskStatus,
  to: TaskStatus,
  viewer: { manager: boolean },
): boolean {
  return isTaskStatus(to) && (viewer.manager || ordinaryTaskStatusMove(from, to));
}

export function taskStatusNeedsOwner(status: TaskStatus): boolean {
  return status !== "todo" && status !== "closed";
}

export function taskStatusAwaitsReceipt(
  status: TaskStatus,
  task: { requiresReceipt: boolean; hasReceipt: boolean },
): boolean {
  return status === "done" && task.requiresReceipt && !task.hasReceipt;
}
