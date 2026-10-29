import { taskStatusMoveAllowed, type TaskStatus, type TaskView } from "@lrm/coforge-sdk/internal";

export type TaskMoveCommand =
  | { operation: "claim"; number: number }
  | {
      operation: "update";
      number: number;
      status: TaskStatus;
      expectedRevision: number;
    };

/**
 * Browser movement policy mirroring TaskBoard's claim and update authorization: which command, if
 * any, moves this Task to `nextStatus`. The status rule is the shared one (`taskStatusMoveAllowed`
 * in the SDK), so the board never offers a move the server refuses; `canSetAnyStatus` is the
 * viewer's Workspace role, which lets an owner or admin set any status.
 */
export function getTaskMoveCommand(
  task: TaskView,
  currentMemberId: string | null,
  nextStatus: TaskStatus,
  { canSetAnyStatus = false }: { canSetAnyStatus?: boolean } = {},
): TaskMoveCommand | undefined {
  if (!currentMemberId || task.status === nextStatus) return undefined;
  if (!taskStatusMoveAllowed(task.status, nextStatus, { manager: canSetAnyStatus }))
    return undefined;
  const own = task.owner?.memberId === currentMemberId;

  if (task.status === "todo" && (!task.owner || own) && nextStatus === "in_progress") {
    return { operation: "claim", number: task.number };
  }

  // Only the owner works a task: anyone else may reopen it, finish it or close it. A Workspace
  // owner or admin may work it too, as the server lets them set any status. A Task nobody owns
  // still cannot become In progress, In review or Done (the server answers CONFLICT), whoever asks.
  if (!canSetAnyStatus && !own && (nextStatus === "in_progress" || nextStatus === "in_review"))
    return undefined;
  if (nextStatus === "done" && !task.owner) return undefined;

  return {
    operation: "update",
    number: task.number,
    status: nextStatus,
    expectedRevision: task.revision,
  };
}

/** The status menu's order: forward first, then back for rework, then Closed. */
const MENU_ORDER: readonly TaskStatus[] = ["todo", "in_progress", "in_review", "done", "closed"];

/** The status menu's choices: the current status, then each move the viewer can make. */
export function taskStatusOptions(
  task: TaskView,
  currentMemberId: string | null,
  options?: { canSetAnyStatus?: boolean },
): TaskStatus[] {
  return [
    task.status,
    ...MENU_ORDER.filter(
      (next) => next !== task.status && getTaskMoveCommand(task, currentMemberId, next, options),
    ),
  ];
}
