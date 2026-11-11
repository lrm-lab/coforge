import { TASK_ASSIGN_REASON_MAX_LENGTH, taskAssignReasonProblem } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";

/**
 * The one handover sentence `task assign --reason` carries. It is shown next to the assignment,
 * so a blank, wrapped or over-long sentence is refused instead of reshaped: the assignee should
 * read exactly what the assigner meant. The rules themselves are shared with the server, which
 * refuses the same sentences however they arrive (task #36). `undefined` means no sentence was
 * given, which is every ordinary assignment.
 */
export function parseAssignReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const problem = taskAssignReasonProblem(value);
  if (problem === "empty") throw invalid("--reason must say something");
  if (problem === "multi_line") throw invalid("--reason must be a single line");
  if (problem === "too_long")
    throw invalid(`--reason is longer than ${TASK_ASSIGN_REASON_MAX_LENGTH} characters`);
  return value.trim();
}

function invalid(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}
