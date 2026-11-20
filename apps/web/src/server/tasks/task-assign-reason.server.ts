import {
  TASK_ASSIGN_REASON_MAX_LENGTH,
  TASK_STATUS_REASON_MAX_LENGTH,
  type TaskAssignReasonProblem,
  type TaskStatusReasonProblem,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";

export const TASK_ASSIGN_REASON_INVALID = "task_assign_reason_invalid";
export const TASK_STATUS_REASON_INVALID = "task_status_reason_invalid";
export const TASK_SOURCE_MESSAGE_REQUIRED = "task_source_message_required";

const ASSIGN_HINTS: Record<TaskAssignReasonProblem, string> = {
  empty: "an assignment's reason must say something",
  too_long: `an assignment's reason must be at most ${TASK_ASSIGN_REASON_MAX_LENGTH} characters`,
  self_assign:
    "reason is only for handing a task to someone else (not for taking it yourself or clearing the assignee)",
  required:
    "handing a task to someone else requires --reason: one line on what the task waits on them for",
};

const STATUS_HINTS: Record<TaskStatusReasonProblem, string> = {
  not_backlog: "reason is only for moving a task to backlog",
  too_long: `reason must be at most ${TASK_STATUS_REASON_MAX_LENGTH} characters`,
};

export function refuseAssignReason(problem: TaskAssignReasonProblem): never {
  throw new AppError("INVALID_INPUT", {
    errorId: TASK_ASSIGN_REASON_INVALID,
    hint: ASSIGN_HINTS[problem],
  });
}

export function refuseStatusReason(problem: TaskStatusReasonProblem): never {
  throw new AppError("INVALID_INPUT", {
    errorId: TASK_STATUS_REASON_INVALID,
    hint: STATUS_HINTS[problem],
  });
}
