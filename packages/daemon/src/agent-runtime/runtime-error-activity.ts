import type { AgentActivity, AgentRuntimeEvent } from "@coforge/agent";
import { AGENT_ACTIVITY_DETAIL_KIND, truncateCodePoints } from "@lrm/coforge-sdk/internal";
import {
  classifyRuntimeError,
  type RuntimeErrorClassification,
} from "./runtime-error-classification";
import type { RuntimeErrorFingerprintFenceState } from "./runtime-error-recovery";

/**
 * The single place a provider's error, crash or reconnect report becomes an Activity: a
 * provider's own message is shown as reported; the crash summary built at process exit is
 * redacted and capped at 512 characters; every runtime failure gets the same structured
 * classification and fingerprint.
 */

/** Matches the cap `daemon-runtime/runtime.ts`'s `safeRuntimeActivityMessage`
 * already applies to every other error-level Activity (spec: "Length limit"). */
const MAX_VISIBLE_ERROR_CHARS = 512;

/**
 * Redacts secrets that might appear in a raw provider error/crash message before
 * it becomes visible Activity text. CoForge's redaction here is intentionally
 * broader than a plain `Bearer <token>`/API-key regex: it also catches generic
 * `key=value`-shaped credential assignments (`token=...`, `password=...`), not
 * just recognized token prefixes. Reused by every provider's `error`/
 * `reconnecting` event, so there is exactly one redaction implementation for
 * runtime-failure text. The daemon runtime also calls this function directly
 * for warning-level and other error-adjacent Activity text, keeping those
 * rules in the same implementation.
 *
 * The `key=value` pattern keeps its prefix via a real capturing group, matching
 * `redactTrajectoryText` in activity-trajectory.ts (`$1[REDACTED]`) — the
 * previous `runtime.ts` copy of this rule referenced a non-existent capture
 * group (`"$1=[REDACTED]"` with no parentheses around the prefix), which left
 * a literal `$1=` in the output instead of redacting the value; fixed here as
 * part of consolidating every runtime-failure scrubber into this one function.
 */
export function scrubRuntimeErrorText(message: string): string {
  const redacted = message
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return truncateCodePoints(redacted, MAX_VISIBLE_ERROR_CHARS);
}

/**
 * FNV-1a 32-bit hash rendered as 8 hex characters — the one fingerprint
 * algorithm shared by every runtime failure's `runtimeError.fingerprint`,
 * grouping repeats of what is, after redaction, the same failure text.
 * Previously duplicated between the Codex provider (its own `fingerprint()`)
 * and this module's daemon-core equivalent; the Codex provider now reuses this
 * implementation via its own richer `providerErrorCode`/`providerErrorClass`.
 */
export function fingerprintRuntimeError(message: string): string {
  let hash = 2166136261;
  for (const character of message) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type RuntimeErrorEvent = Extract<AgentRuntimeEvent, { type: "error" }>;
export type RuntimeReconnectingEvent = Extract<AgentRuntimeEvent, { type: "reconnecting" }>;

/** When an exhausted quota resets, as a suffix to a live failure's visible wording, if known.
 * Never part of a fingerprint (the same limit is the same failure whatever reset it names), nor
 * of the fence or crash wording, which quote the provider text alone. */
function limitResetNote(event: RuntimeErrorEvent): string {
  const limit = event.providerLimit;
  return limit?.kind === "quota_exhausted" && limit.resetsAt
    ? ` (limit resets at ${limit.resetsAt})`
    : "";
}

/** The class and reason a failure reports: the classification's for a provider's normalized
 * limit, else a provider's own free-form class/code and reason hints as-is, else the
 * classification's. `classify` runs at most once, and only when its result is used. */
function reportedClassification(
  event: RuntimeErrorEvent,
  classify: () => RuntimeErrorClassification,
): { errorClass: string; errorReason: string } {
  let classified: RuntimeErrorClassification | undefined;
  const classification = () => (classified ??= classify());
  if (event.providerLimit) {
    const { errorClass, errorReason } = classification();
    return { errorClass, errorReason };
  }
  return {
    errorClass: event.providerErrorClass ?? event.providerErrorCode ?? classification().errorClass,
    errorReason: event.providerErrorReason ?? classification().errorReason,
  };
}

/**
 * Builds the visible Activity for a provider-reported `error` event observed
 * mid-turn. Always attaches a single `{ kind: "text", text: "Error: ..." }`
 * trajectory entry (spec §7) alongside the top-level `detail`, so the message
 * is visible both in the current-status line and in the popover/history entry.
 */
export function buildRuntimeErrorActivity(
  event: RuntimeErrorEvent,
  // Passed in by a caller that already classified this failure for its own decision.
  classified: RuntimeErrorClassification = classifyRuntimeError(event),
): AgentActivity {
  // A provider's own error message is shown as reported; only the crash summary built at
  // process exit is redacted and capped.
  const detail = `${event.message}${limitResetNote(event)}`;
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
    level: "error",
    detail,
    observedAtMs: event.occurredAt ? Date.parse(event.occurredAt) : Date.now(),
    entries: [{ kind: "text", text: `Error: ${detail}` }],
    runtimeError: {
      ...reportedClassification(event, () => classified),
      fingerprint: fingerprintRuntimeError(event.message),
    },
  };
}

/** Overrides a runtime_error Activity's wording once the fingerprint fence has tripped: same
 * detailKind/level (still an ordinary runtime_error, so nothing new appears in a client that
 * does not yet know about fencing), but a distinguishable `errorReason` and a detail that names
 * the repeat and how to recover — CoForge's own words, not the last raw provider message alone. */
export function buildRuntimeErrorFingerprintFenceActivity(
  built: ReturnType<typeof buildRuntimeErrorActivity>,
  fence: RuntimeErrorFingerprintFenceState,
  lastError: RuntimeErrorEvent,
): ReturnType<typeof buildRuntimeErrorActivity> {
  const detail = `Runtime stopped retrying after ${fence.attempts} consecutive failures with the same underlying error. Last error: ${lastError.message} Restart this Agent once the issue is fixed.`;
  return {
    ...built,
    detail,
    entries: [{ kind: "text", text: `Error: ${detail}` }],
    runtimeError: built.runtimeError && {
      ...built.runtimeError,
      errorReason: "runtime_error_fenced",
    },
  };
}

/**
 * Builds the visible Activity for a process exit that leaves an `error` event
 * unresolved (no `completed` observed after it) — a real crash, not a clean
 * idle exit. `lastError` is the most recent unresolved `error` event's already-
 * tracked facts (daemon-runtime/runtime.ts clears it on `completed`); the exit
 * itself carries no OS-level exit code/signal (`AgentSession.onExit` takes no
 * arguments in this codebase), so "Crashed" wording can only describe the last
 * observed error, never a signal/exit-code summary the way the behavioural
 * reference does — see the report for that difference.
 */
export function buildRuntimeCrashedActivity(lastError: RuntimeErrorEvent): AgentActivity {
  const detail = `Crashed (${scrubRuntimeErrorText(lastError.message)})`;
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_CRASHED,
    level: "error",
    detail,
    observedAtMs: Date.now(),
    entries: [{ kind: "text", text: `Error: ${detail}` }],
    runtimeError: {
      // The exit reason itself is always "runtime_crashed" below, regardless of the underlying
      // error's own class; only the class is worth refining from an unhinted provider message.
      errorClass: reportedClassification(lastError, () => classifyRuntimeError(lastError))
        .errorClass,
      errorReason: "runtime_crashed",
      fingerprint: fingerprintRuntimeError(detail),
    },
  };
}

/** Builds the visible Activity for a provider reconnecting to its upstream. */
export function buildRuntimeReconnectingActivity(event: RuntimeReconnectingEvent): AgentActivity {
  let detail = event.message || "Reconnecting to provider…";
  if (event.delayMs !== undefined) {
    const facts = [`backoff ${event.delayMs / 1000}s`];
    if (event.attempt !== undefined)
      facts.unshift(
        `attempt ${event.attempt}${event.maxAttempts === undefined ? "" : `/${event.maxAttempts}`}`,
      );
    detail = scrubRuntimeErrorText(
      `Retrying provider request (${facts.join(", ")})${event.message ? `: ${event.message}` : ""}`,
    );
  }
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING,
    level: "info",
    detail,
    observedAtMs: Date.now(),
    entries: [{ kind: "text", text: detail }],
  };
}
