import { isActivityCallId } from "./activity-entries";

/** How one tool call ended: carried by its `tool_end` Activity, keyed by the `callId` of the
 * call's `tool_start` entry. What each field means: docs/observability/agent-status-and-activity/detail-kinds.md
 * (`tool_end`). */
export type ActivityToolOutcome = {
  callId: string;
  ok: boolean;
  durationMs?: number;
  exitCode?: number;
};

/** Whether `value` fits the wire's `int32 exit_code`. */
export function isActivityExitCode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= -(2 ** 31) && (value as number) < 2 ** 31;
}

export function isActivityToolOutcome(value: unknown): value is ActivityToolOutcome {
  if (!value || typeof value !== "object") return false;
  const outcome = value as Record<string, unknown>;
  return (
    isActivityCallId(outcome.callId) &&
    typeof outcome.ok === "boolean" &&
    (outcome.durationMs === undefined ||
      (Number.isSafeInteger(outcome.durationMs) && (outcome.durationMs as number) >= 0)) &&
    (outcome.exitCode === undefined || isActivityExitCode(outcome.exitCode))
  );
}
