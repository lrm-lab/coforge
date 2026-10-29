import type { TaskStatus } from "@lrm/coforge-sdk/internal";

/**
 * The statuses a Task may move to in ordinary hands, as the reference product's board works: work
 * moves forward Todo → In Progress → In Review → Done, In Review may be sent back to In Progress
 * for more work, Closed may be set from anywhere, and a finished Task may be reopened. A Workspace
 * owner or admin may set any status at all; this table is what everyone else may do.
 */
const ORDINARY_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "closed"],
  in_review: ["in_progress", "done", "closed"],
  // A Done Task goes back to Todo, In Progress or In Review.
  done: ["todo", "in_progress", "in_review", "closed"],
  // A Closed Task reopens to Todo only.
  closed: ["todo"],
};

/** Whether someone who is not a Workspace owner or admin may move a Task from one status to
 * another. The same status is not a move: it is accepted and changes nothing. */
export function ordinaryTaskStatusMove(from: TaskStatus, to: TaskStatus): boolean {
  return to === from || ORDINARY_TRANSITIONS[from].includes(to);
}
