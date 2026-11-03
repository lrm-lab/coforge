import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import { CliError, withOutputMode } from "#src/cli-error";
import { formatHeldTaskRequest } from "#src/task-format";

/**
 * A held task write is a refusal, not a result: nothing was written, so the process must not exit
 * as if it had succeeded. The held context rides along as `contextText` in text mode and as
 * `details` in JSON mode, and the hold's `--anyway` exit stays in that context.
 */
export function heldTaskCliError(
  command: TaskCommand,
  result: TaskResult,
  json: boolean,
): CliError {
  const reviewerIsolation = command.freshnessContextMode === "withheld";
  const context = formatHeldTaskRequest(command, result, reviewerIsolation);
  const withheld = reviewerIsolation || result.freshnessContextMode === "withheld";
  const error = new CliError({
    code: "TASK_REQUEST_HELD",
    message: withheld ? context : "Task request held; no task was written.",
    retryable: false,
    contextText: withheld ? undefined : context,
    suggestedNextAction: "Review the newer messages, then run the command again.",
    details: withheld
      ? undefined
      : { heldMessages: result.heldMessages, newMessageCount: result.newMessageCount },
  });
  return json ? withOutputMode(error, "json") : error;
}
