import {
  TASK_ASSIGN_REASON_MAX_LENGTH,
  type TaskAssignReasonProblem,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";

/** An assignment whose handover sentence the server will not store: blank, wrapped, or too long. */
export const TASK_ASSIGN_REASON_INVALID = "task_assign_reason_invalid";

const HINTS: Record<TaskAssignReasonProblem, string> = {
  empty: "an assignment's reason must say something",
  multi_line: "an assignment's reason must be a single line",
  too_long: `an assignment's reason must be at most ${TASK_ASSIGN_REASON_MAX_LENGTH} characters`,
};

/**
 * Refuses a reason the CLI would have refused too: the sentence is shown next to the assignment, so
 * the board stores it exactly as one line instead of reshaping whatever an API caller sent (task
 * #36). The hint is written for an Agent because an Agent is the caller that gets it back.
 */
export function refuseAssignReason(problem: TaskAssignReasonProblem): never {
  throw new AppError("INVALID_INPUT", {
    errorId: TASK_ASSIGN_REASON_INVALID,
    hint: HINTS[problem],
  });
}
