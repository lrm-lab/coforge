import {
  TASK_WRITE_STATUSES,
  taskStatusAwaitsReceipt,
  taskStatusMoveAllowed,
  type TaskStatus,
  type TaskWriteStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";

export type TaskMoveCommand =
  | { operation: "claim"; number: number }
  | {
      operation: "update";
      number: number;
      status: TaskWriteStatus;
      expectedRevision: number;
    };

export function getTaskMoveCommand(
  task: TaskView,
  currentMemberId: string | null,
  nextStatus: TaskWriteStatus,
  { canSetAnyStatus = false }: { canSetAnyStatus?: boolean } = {},
): TaskMoveCommand | undefined {
  if (!currentMemberId || task.status === nextStatus) return undefined;
  if (!taskStatusMoveAllowed(task.status, nextStatus, { manager: canSetAnyStatus }))
    return undefined;
  const own = task.owner?.memberId === currentMemberId;

  if (
    (task.status === "todo" || task.status === "backlog") &&
    (!task.owner || own) &&
    nextStatus === "in_progress"
  ) {
    return { operation: "claim", number: task.number };
  }

  if (
    taskStatusAwaitsReceipt(nextStatus, {
      requiresReceipt: Boolean(task.requiresResourceReceipt),
      hasReceipt: Boolean(task.resourceReceipt),
    })
  )
    return undefined;

  return {
    operation: "update",
    number: task.number,
    status: nextStatus,
    expectedRevision: task.revision,
  };
}

const MENU_ORDER: readonly TaskWriteStatus[] = TASK_WRITE_STATUSES;

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
