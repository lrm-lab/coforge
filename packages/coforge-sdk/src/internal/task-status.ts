export const TASK_WRITE_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;
export type TaskWriteStatus = (typeof TASK_WRITE_STATUSES)[number];
export const TASK_READ_STATUSES = ["backlog", ...TASK_WRITE_STATUSES] as const;
export type TaskStatus = (typeof TASK_READ_STATUSES)[number];
export const isTaskReadStatus = (value: string): value is TaskStatus =>
  (TASK_READ_STATUSES as readonly string[]).includes(value);

export const isTaskWriteStatus = (value: string): value is TaskWriteStatus =>
  (TASK_WRITE_STATUSES as readonly string[]).includes(value);

export const ORDINARY_TASK_STATUS_MOVES: Record<TaskStatus, readonly TaskWriteStatus[]> = {
  backlog: ["todo", "in_progress", "closed"],
  todo: ["in_progress", "closed"],
  in_progress: ["todo", "in_review", "closed"],
  in_review: ["in_progress", "done", "closed"],
  done: ["todo", "in_progress", "in_review", "closed"],
  closed: ["todo"],
};

export function ordinaryTaskStatusMove(from: TaskStatus, to: TaskWriteStatus): boolean {
  return to === from || ORDINARY_TASK_STATUS_MOVES[from].includes(to);
}

export function taskStatusMoveAllowed(
  from: TaskStatus,
  to: TaskWriteStatus,
  viewer: { manager: boolean },
): boolean {
  return isTaskWriteStatus(to) && (viewer.manager || ordinaryTaskStatusMove(from, to));
}

export function taskStatusNeedsOwner(status: TaskWriteStatus): boolean {
  return status !== "todo" && status !== "closed";
}

export function taskStatusAwaitsReceipt(
  status: TaskWriteStatus,
  task: { requiresReceipt: boolean; hasReceipt: boolean },
): boolean {
  return status === "done" && task.requiresReceipt && !task.hasReceipt;
}
