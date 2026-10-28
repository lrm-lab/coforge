import type { AgentActivity, AgentRuntimeEvent } from "@coforge/agent";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  RUNTIME_PROVIDER,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import {
  classifyRuntimeError,
  isRuntimePlanAccessText,
  type ClassifiedRuntimeErrorAction,
  type RuntimeErrorClassification,
} from "./runtime-error-classification";
import { scrubRuntimeErrorText } from "@lrm/coforge-anvil";
import { DSH_MISSING_KEY_MESSAGE } from "@lrm/coforge-anvil/dsh";
import type {
  RuntimeErrorClassFenceState,
  RuntimeErrorFingerprintFenceState,
} from "./runtime-error-recovery";

/**
 * The single place a provider's error, crash or reconnect report becomes an Activity: a
 * provider's own message is shown as reported; the crash summary built at process exit is
 * redacted and capped at 512 characters; every runtime failure gets the same structured
 * classification and fingerprint.
 */

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

/**
 * What an action-required Activity needs about the Agent's launch config: which runtime
 * reported the failure, the configured model, and whether the Agent carries its own provider
 * key (`providerConfig.kind === "coforge"` — the "custom provider" setting), which changes whose
 * credentials a person must fix.
 */
export type RuntimeActionRequiredContext = Readonly<{
  provider: RuntimeProvider;
  providerLabel: string;
  model: string;
  agentProviderKey: boolean;
}>;

/** The diagnostic subtype an action-required Activity reports, mirroring the reference
 * Computer's `classifyRuntimeActionRequiredSubtype`. */
function runtimeActionRequiredSubtype(
  message: string,
  context: RuntimeActionRequiredContext,
): string {
  if (isRuntimePlanAccessText(message)) return "provider_plan_access_error";
  if (context.agentProviderKey) {
    if (
      /\bmissing\b.*\b(?:api\s*)?key\b|\b(?:api\s*)?key\b.*\bnot set\b|\bmissing\b.*\btoken\b|\bno\b.*\btoken\b/i.test(
        message,
      )
    )
      return "custom_provider_missing_key";
    if (
      /\binvalid\b.*\b(?:api\s*)?key\b|\bunauthorized\b|\b401\b|\b403\b|auth(?:entication)? failed/i.test(
        message,
      )
    )
      return "custom_provider_invalid_key";
    return "custom_provider_auth_error";
  }
  if (context.provider === RUNTIME_PROVIDER.CLAUDE_CODE) {
    const lower = message.toLowerCase();
    if (
      lower.includes("not logged in") ||
      lower.includes("not signed in") ||
      lower.includes("please log in") ||
      lower.includes("login required")
    )
      return "host_claude_login_required";
    return "runtime_auth_error";
  }
  if (context.provider === RUNTIME_PROVIDER.COFORGE) return "builtin_provider_auth_error";
  return "runtime_auth_error";
}

/** The person-facing wording an action-required failure shows, mirroring the reference
 * Computer's `formatRuntimeActionRequiredMessage`. */
function runtimeActionRequiredMessage(
  requiredAction: ClassifiedRuntimeErrorAction,
  message: string,
  context: RuntimeActionRequiredContext,
): string {
  if (requiredAction === "user_model_access") {
    const modelLabel = context.model.trim() ? ` (${context.model.trim()})` : "";
    return `${context.providerLabel} reported that the provider plan for this Agent does not include access to the configured model${modelLabel}. CoForge stopped retrying because retries cannot succeed until the model or the plan changes. Switch this Agent to a model the plan includes, or upgrade the plan, then retry starting this Agent.`;
  }
  if (context.agentProviderKey)
    return `${context.providerLabel} custom provider authentication failed. Check this Agent's provider API key/API URL, then retry starting this Agent.`;
  if (context.provider === RUNTIME_PROVIDER.COFORGE)
    return "Built-in provider authentication failed. Check this Agent's provider API key and region/provider selection, then retry starting this Agent.";
  if (context.provider === RUNTIME_PROVIDER.PI)
    return "Pi's model provider rejected the API key, or no key is set for it on this machine. Check the API key for this Agent's provider, then retry starting this Agent.";
  // DSH reports a missing key as `DSH_MISSING_KEY_MESSAGE`; any other sign-in failure is a key it has.
  if (context.provider === RUNTIME_PROVIDER.DSH)
    return message === DSH_MISSING_KEY_MESSAGE
      ? "DeepSeek Harness has no DeepSeek API key on this machine. Add one with `dsh web`, or set DEEPSEEK_API_KEY for the Computer, then retry starting this Agent."
      : "DeepSeek Harness's DeepSeek API key was rejected. Replace it with `dsh web`, or set DEEPSEEK_API_KEY for the Computer, then retry starting this Agent.";
  return `${context.providerLabel} is not logged in on this machine. Please log in to ${context.providerLabel} locally, then retry starting this Agent.`;
}

/** The Activity a runtime failure needing a person's action reports: the provider text is
 * replaced by wording that says what to fix, followed by a diagnostic subtype and a redacted
 * excerpt of the raw message. `runtimeError.requiredAction` carries the action on the wire. */
export function buildRuntimeActionRequiredActivity(
  event: RuntimeErrorEvent,
  classified: RuntimeErrorClassification,
  context: RuntimeActionRequiredContext,
): AgentActivity {
  const detail = runtimeActionRequiredMessage(classified.requiredAction, event.message, context);
  const subtype = runtimeActionRequiredSubtype(event.message, context);
  const diagnosticLabel =
    subtype === "provider_plan_access_error"
      ? "Runtime model-access diagnostic"
      : "Runtime auth diagnostic";
  const entries = [
    { kind: "text" as const, text: `Error: ${detail}` },
    { kind: "text" as const, text: `${diagnosticLabel}: ${subtype}` },
    {
      kind: "text" as const,
      text: `Raw error excerpt (redacted): ${scrubRuntimeErrorText(event.message)}`,
    },
  ];
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
    level: "error",
    detail,
    observedAtMs: event.occurredAt ? Date.parse(event.occurredAt) : Date.now(),
    entries,
    runtimeError: {
      ...reportedClassification(event, () => classified),
      fingerprint: fingerprintRuntimeError(event.message),
      ...(classified.requiredAction !== "none"
        ? { requiredAction: classified.requiredAction }
        : {}),
    },
  };
}

/** The Activity an exhausted provider billing/credit balance reports: no `requiredAction`
 * (refilling the balance is a provider-side act, not a client action), but the same offline
 * semantics as an action-required failure — the detail says why retrying stopped and what
 * restores the Agent, followed by a redacted excerpt of the raw message. Mirrors the reference
 * Computer's `formatRuntimeBillingExhaustedMessage`. */
export function buildRuntimeBillingExhaustedActivity(
  event: RuntimeErrorEvent,
  classified: RuntimeErrorClassification,
  providerLabel: string,
): AgentActivity {
  const detail = `${providerLabel} reported that the provider's billing or credit balance is exhausted. CoForge stopped retrying because retries cannot succeed until the balance is restored. Messages that were waiting are kept and will be delivered when the agent starts again. Add credits or switch this agent to another model or provider, then restart the agent.`;
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
    level: "error",
    detail,
    observedAtMs: event.occurredAt ? Date.parse(event.occurredAt) : Date.now(),
    entries: [
      { kind: "text", text: `Error: ${detail}` },
      {
        kind: "text",
        text: `Raw error excerpt (redacted): ${scrubRuntimeErrorText(event.message)}`,
      },
    ],
    runtimeError: {
      ...reportedClassification(event, () => classified),
      fingerprint: fingerprintRuntimeError(event.message),
    },
  };
}

/** Overrides a runtime_error Activity's wording once the fingerprint fence has tripped: same
 * detailKind/level (still an ordinary runtime_error, so nothing new appears in a client that
 * does not yet know about fencing), but a distinguishable `errorReason` and a detail that names
 * the repeat and how to recover — the reference Computer's fence wording, not the last raw
 * provider message alone. */
export function buildRuntimeErrorFingerprintFenceActivity(
  built: ReturnType<typeof buildRuntimeErrorActivity>,
  fence: RuntimeErrorFingerprintFenceState,
  lastError: RuntimeErrorEvent,
): ReturnType<typeof buildRuntimeErrorActivity> {
  const detail = `Runtime stopped after ${fence.attempts} repeated runtime errors with the same fingerprint (${fence.fingerprint}). Last error: ${lastError.message} Restart after the runtime/tooling issue is fixed.`;
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

/** Class fence shares terminal residency with the fingerprint fence. */
export function buildRuntimeErrorClassFenceActivity(
  built: ReturnType<typeof buildRuntimeErrorActivity>,
  fence: RuntimeErrorClassFenceState,
  lastError: RuntimeErrorEvent,
): ReturnType<typeof buildRuntimeErrorActivity> {
  const detail = `Runtime stopped after ${fence.attempts} consecutive "not found" (HTTP 404) runtime errors with no progress in between. Last error: ${scrubRuntimeErrorText(lastError.message)} Check the configured model and endpoint, then restart.`;
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

/** Both fences share terminal residency; fingerprint outcomes have precedence at the caller. */
export function buildRuntimeErrorFenceActivity(
  built: ReturnType<typeof buildRuntimeErrorActivity>,
  fence: RuntimeErrorFingerprintFenceState | RuntimeErrorClassFenceState,
  lastError: RuntimeErrorEvent,
): ReturnType<typeof buildRuntimeErrorActivity> {
  return "fingerprint" in fence
    ? buildRuntimeErrorFingerprintFenceActivity(built, fence, lastError)
    : buildRuntimeErrorClassFenceActivity(built, fence, lastError);
}
