import type { UsageSnapshot } from "@coforge/agent";
import { AGENT_ACTIVITY_DETAIL_KIND, truncateCodePoints } from "@lrm/coforge-sdk/internal";
import {
  fingerprintRuntimeError,
  scrubRuntimeErrorText,
} from "#src/agent-runtime/runtime-error-activity";

/** The visible text one Activity carries: bounded, redacted by level and kind, and never an
 * empty sentence for a kind that legitimately has no text. */
export function safeRuntimeActivityMessage(
  activity: string,
  level: string,
  message: string,
): string {
  if (level === "error") return truncateCodePoints(message, 512);
  if (level === "warning") return scrubRuntimeErrorText(message);
  if (activity === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS) return "";
  if (activity === AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND)
    return truncateCodePoints(scrubRuntimeErrorText(message), 200);
  if (
    activity === AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED ||
    activity === AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED ||
    activity === AGENT_ACTIVITY_DETAIL_KIND.CHECKING_MESSAGES ||
    activity === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING ||
    activity === AGENT_ACTIVITY_DETAIL_KIND.THINKING_END
  ) {
    return scrubRuntimeErrorText(message);
  }
  // The content-free run-start announcement (ActivityTrajectory#startRun) carries no
  // message; let it through empty instead of falling to the generic sentence below.
  if (
    (activity === AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED ||
      activity === AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED) &&
    !message
  ) {
    return "";
  }
  return "Agent activity observed.";
}

export function runtimeFailureDiagnostic(message: string) {
  const safe = scrubRuntimeErrorText(message);
  return {
    errorClass: "AgentRuntimeError",
    errorReason: "runtime_failure",
    fingerprint: fingerprintRuntimeError(safe),
  };
}

export function validUsageWindow(
  window: UsageSnapshot["primary"],
  now: number,
): UsageSnapshot["primary"] {
  return window && window.resetsAt !== undefined && Date.parse(window.resetsAt) > now
    ? window
    : undefined;
}
