import { TASK_ASSIGN_REASON_MAX_LENGTH } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";

/**
 * The one handover sentence `task assign --reason` carries. It is shown next to the assignment,
 * so a blank, wrapped or over-long sentence is refused instead of reshaped: the assignee should
 * read exactly what the assigner meant. `undefined` means no sentence was given, which is every
 * ordinary assignment.
 */
export function parseAssignReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sentence = value.trim();
  if (!sentence) throw invalid("--reason must say something");
  if (/[\r\n]/.test(sentence)) throw invalid("--reason must be a single line");
  if (sentence.length > TASK_ASSIGN_REASON_MAX_LENGTH)
    throw invalid(`--reason is longer than ${TASK_ASSIGN_REASON_MAX_LENGTH} characters`);
  return sentence;
}

function invalid(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}
