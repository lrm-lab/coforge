import { TASK_ASSIGN_REASON_MAX_LENGTH } from "./tasks";

/**
 * Why an assignment's handover sentence cannot be stored, or `undefined` when it can: it must say
 * something, fit on one line, and stay within `TASK_ASSIGN_REASON_MAX_LENGTH` characters. The CLI
 * and the server both ask, so a write through the API cannot store a sentence the CLI would have
 * refused (task #36) — the sentence is shown next to the assignment, and the assignee reads exactly
 * what the assigner meant.
 */
export type TaskAssignReasonProblem = "empty" | "multi_line" | "too_long";

export function taskAssignReasonProblem(sentence: string): TaskAssignReasonProblem | undefined {
  const trimmed = sentence.trim();
  if (!trimmed) return "empty";
  if (/[\r\n]/.test(trimmed)) return "multi_line";
  if (trimmed.length > TASK_ASSIGN_REASON_MAX_LENGTH) return "too_long";
  return undefined;
}
