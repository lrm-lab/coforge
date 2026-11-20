import { TASK_ASSIGN_REASON_MAX_LENGTH } from "./tasks";
import type { TaskStatus } from "./task-status";

export const TASK_STATUS_REASON_MAX_LENGTH = TASK_ASSIGN_REASON_MAX_LENGTH;

export type TaskAssignReasonProblem = "empty" | "too_long" | "self_assign" | "required";
export type TaskStatusReasonProblem = "not_backlog" | "too_long";

export function normalizeTaskReasonText(reason: string): string {
  return reason.replace(/[\s\u0085]+/g, " ").trim();
}

export function taskAssignReasonProblem(sentence: string): "empty" | "too_long" | undefined {
  const normalized = normalizeTaskReasonText(sentence);
  if (!normalized) return "empty";
  if (normalized.length > TASK_ASSIGN_REASON_MAX_LENGTH) return "too_long";
  return undefined;
}

export function taskStatusReasonProblem(
  status: TaskStatus,
  sentence: string,
): TaskStatusReasonProblem | undefined {
  if (status !== "backlog") return "not_backlog";
  const normalized = normalizeTaskReasonText(sentence);
  if (!normalized) return undefined;
  if (normalized.length > TASK_STATUS_REASON_MAX_LENGTH) return "too_long";
  return undefined;
}
