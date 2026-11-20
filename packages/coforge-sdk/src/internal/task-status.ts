export const TASK_WRITE_STATUSES = ["backlog", "todo", "in_progress", "done", "closed"] as const;
export type TaskWriteStatus = (typeof TASK_WRITE_STATUSES)[number];
export const TASK_CREATE_STATUSES = ["backlog", "todo", "in_progress"] as const;
export type TaskCreateStatus = (typeof TASK_CREATE_STATUSES)[number];
export const TASK_READ_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "closed",
] as const;
export type TaskStatus = (typeof TASK_READ_STATUSES)[number];

export const isTaskReadStatus = (value: string): value is TaskStatus =>
  (TASK_READ_STATUSES as readonly string[]).includes(value);

export const isTaskWriteStatus = (value: string): value is TaskWriteStatus =>
  (TASK_WRITE_STATUSES as readonly string[]).includes(value);

export const isTaskCreateStatus = (value: string): value is TaskCreateStatus =>
  (TASK_CREATE_STATUSES as readonly string[]).includes(value);

export function normalizeTaskWriteStatus(status: TaskStatus): TaskWriteStatus {
  return status === "in_review" ? "in_progress" : status;
}

export const ORDINARY_TASK_STATUS_MOVES: Record<TaskStatus, readonly TaskWriteStatus[]> = {
  backlog: TASK_WRITE_STATUSES,
  todo: TASK_WRITE_STATUSES,
  in_progress: TASK_WRITE_STATUSES,
  in_review: TASK_WRITE_STATUSES,
  done: TASK_WRITE_STATUSES,
  closed: TASK_WRITE_STATUSES,
};

export function ordinaryTaskStatusMove(_from: TaskStatus, to: TaskWriteStatus): boolean {
  return isTaskWriteStatus(to);
}

export function taskStatusMoveAllowed(
  _from: TaskStatus,
  to: TaskWriteStatus,
  _viewer?: { manager: boolean },
): boolean {
  return isTaskWriteStatus(to);
}

export function taskStatusNeedsOwner(_status: TaskWriteStatus): boolean {
  return false;
}

export function taskStatusAwaitsReceipt(
  status: TaskWriteStatus,
  task: { requiresReceipt: boolean; hasReceipt: boolean },
): boolean {
  return status === "done" && task.requiresReceipt && !task.hasReceipt;
}
