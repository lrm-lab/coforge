export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * The statuses a Task may move to in ordinary hands, as the reference product's board works: work
 * moves forward Todo → In Progress → In Review → Done, In Progress may be withdrawn to Todo,
 * In Review may be sent back to In Progress for more work, Closed may be set from anywhere, and a finished Task may be reopened. A Workspace
 * owner or admin may set any status at all; this table is what everyone else may do. The server's
 * TaskBoard and the browser's board both read it, so the two cannot drift apart.
 */
export const ORDINARY_TASK_STATUS_MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["in_progress", "closed"],
  // Back to Todo withdraws a Task that was started by mistake.
  in_progress: ["todo", "in_review", "closed"],
  in_review: ["in_progress", "done", "closed"],
  // A Done Task goes back to Todo, In Progress or In Review.
  done: ["todo", "in_progress", "in_review", "closed"],
  // A Closed Task reopens to Todo only.
  closed: ["todo"],
};

/** Whether someone who is not a Workspace owner or admin may move a Task from one status to
 * another. The same status is not a move: it is accepted and changes nothing. */
export function ordinaryTaskStatusMove(from: TaskStatus, to: TaskStatus): boolean {
  return to === from || ORDINARY_TASK_STATUS_MOVES[from].includes(to);
}

/** Whether this viewer may make the move: a Workspace owner or admin (an Agent whose own role is
 * one included) sets any status, everyone else follows the ordinary table. */
export function taskStatusMoveAllowed(
  from: TaskStatus,
  to: TaskStatus,
  viewer: { manager: boolean },
): boolean {
  return viewer.manager || ordinaryTaskStatusMove(from, to);
}

/** Whether a Task must have an owner to be in this status: only To do and Closed may be nobody's
 * (the server answers CONFLICT otherwise). A Task nobody owns reaches In progress by a claim. */
export function taskStatusNeedsOwner(status: TaskStatus): boolean {
  return status !== "todo" && status !== "closed";
}

/** Whether a Task cannot yet be in this status for want of its resource receipt: one made to
 * create a resource becomes Done only once the receipt is recorded (the server answers CONFLICT
 * otherwise). */
export function taskStatusAwaitsReceipt(
  status: TaskStatus,
  task: { requiresReceipt: boolean; hasReceipt: boolean },
): boolean {
  return status === "done" && task.requiresReceipt && !task.hasReceipt;
}
