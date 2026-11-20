import {
  normalizeTaskReasonText,
  TASK_ASSIGN_REASON_MAX_LENGTH,
  TASK_STATUS_REASON_MAX_LENGTH,
  taskAssignReasonProblem,
  taskStatusReasonProblem,
  type TaskStatus,
} from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";

export function parseAssignReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const problem = taskAssignReasonProblem(value);
  if (problem === "empty") throw invalid("--reason must say something");
  if (problem === "too_long")
    throw invalid(`--reason is longer than ${TASK_ASSIGN_REASON_MAX_LENGTH} characters`);
  return normalizeTaskReasonText(value);
}

export function parseStatusReason(
  status: TaskStatus,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const problem = taskStatusReasonProblem(status, value);
  if (problem === "not_backlog") throw invalid("--reason is only for moving a task to backlog");
  if (problem === "too_long")
    throw invalid(`--reason is longer than ${TASK_STATUS_REASON_MAX_LENGTH} characters`);
  return normalizeTaskReasonText(value) || undefined;
}

function invalid(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}
