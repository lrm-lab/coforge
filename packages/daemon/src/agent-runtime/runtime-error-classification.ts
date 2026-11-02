import { isHttpErrorStatus } from "@lrm/coforge-anvil";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { RUNTIME_ERROR_ACTION, type RuntimeErrorAction } from "@lrm/coforge-sdk/internal";
import {
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
  type RuntimeErrorClass,
  type RuntimeErrorRetryDecision,
} from "./runtime-error-vocabulary";
import {
  CLASSIFICATION_RULES,
  RUNTIME_BILLING_EXHAUSTED_PATTERNS,
  RUNTIME_OFFLINE_MODEL_PATTERN,
  extractHttpStatus,
  isRuntimePlanAccessText,
  quotaResetAt,
} from "./runtime-error-rules";
export { isRuntimePlanAccessText } from "./runtime-error-rules";

/**
 * Turns a runtime failure into a stable CoForge error class, a stable reason, an explicit
 * retry decision, and the action only a person can take — independent of which code-agent
 * provider produced it. This is the one place that decision is made. It reads the failure's
 * own text, any HTTP status the text carries, or a provider's normalized `providerLimit` when
 * there is one (a closed vocabulary, unlike the free-form
 * `providerErrorCode`/`providerErrorClass`/`providerErrorReason` hints, which this table cannot
 * look up). `runtime-error-activity.ts` shows a provider's own class/reason hint as-is when it has
 * one and no limit; `daemon-runtime/runtime.ts` uses the classification unconditionally to decide
 * whether a failure is worth backing off and retrying a held delivery for (see
 * `runtime-error-recovery.ts`) and whether it takes the Agent offline.
 *
 * Table-driven and ordered: the first matching rule wins, so a more specific pattern (a plan that
 * does not include the model, an unsupported model, an oversized prompt) must be listed ahead of
 * a broader one (an HTTP status, a bare "not found"). Every class maps to exactly one of the two
 * decisions in `RUNTIME_ERROR_RETRY_DECISION` — there is no third "maybe" outcome here. The
 * repeat fence in `runtime-error-recovery.ts` stops retrying a failure that repeats with no turn
 * end or output in between; one that ends every turn is never fenced, and the generic fallback's
 * backoff ends with each turn (`daemon-runtime/runtime-error-delivery-hold.ts`).
 *
 * The offline rules follow the reference Computer 1.0.51 (darwin-arm64, release
 * 463fd642-65db-4902-ae9b-c22fbae0e6a0, sha256 364ec010…c78e, observed 2026-10-21): an
 * action-required failure (`requiredAction` other than `none`), an exhausted billing balance or a
 * quota with no known reset, or a sticky model-config failure
 * ends the process and reports the Agent `inactive` until a person fixes the cause and starts it
 * again. A quota or 402 that names its reset instead waits behind that time, showing it in the
 * Activity, rather than taking the Agent offline. `TimeoutError` stays terminal-but-wakeable deliberately: a timeout is handled by the
 * stall watchdog (a stuck provider needs a kill/restart, not a redelivered message), and
 * `takesAgentOffline` must not attach offline semantics to it.
 */

export {
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
  type RuntimeErrorClass,
  type RuntimeErrorRetryDecision,
} from "./runtime-error-vocabulary";

export { RUNTIME_ERROR_ACTION };
/** The action only a person can take before the Agent can work again, or `"none"` — the wire
 * vocabulary lives in `@lrm/coforge-sdk` (`runtime_error_action`); "none" never crosses it. */
export type ClassifiedRuntimeErrorAction = RuntimeErrorAction | "none";

const { RETRY, TERMINAL } = RUNTIME_ERROR_RETRY_DECISION;

export type RuntimeErrorClassification = Readonly<{
  errorClass: RuntimeErrorClass;
  httpStatus?: number;
  errorReason: string;
  retryDecision: RuntimeErrorRetryDecision;
  /** An ISO time no retry can succeed before: an exhausted quota's reported reset. */
  retryNotBefore?: string;
  requiredAction: ClassifiedRuntimeErrorAction;
  /** The failure takes the Agent offline: the daemon ends its process and reports `inactive`.
   * True for every action-required failure, an exhausted billing balance, and a sticky
   * model-config one ("model not supported" / "unsupported model"); other terminal failures
   * keep the Agent wakeable. */
  takesAgentOffline: boolean;
}>;

/**
 * A billing/402 failure, split by whether a recovery time is known: a provider that names the
 * reset is a wait (retry after it), while an exhausted balance or a quota with no reset — a
 * monthly quota, say — cannot resolve by retrying and takes the Agent offline with an Activity
 * that says why. Billing precedes plan access and the status block (reference order).
 */
function billingClassification(
  httpStatus: number | null,
  message: string,
): RuntimeErrorClassification {
  const retryNotBefore = quotaResetAt(message);
  const waiting = retryNotBefore !== undefined;
  return {
    errorClass: waiting ? RUNTIME_ERROR_CLASS.RATE_LIMIT : RUNTIME_ERROR_CLASS.BILLING,
    ...(httpStatus !== null ? { httpStatus } : {}),
    errorReason: waiting ? "quota_exhausted" : "billing_exhausted",
    retryDecision: waiting ? RETRY : TERMINAL,
    ...(retryNotBefore ? { retryNotBefore } : {}),
    requiredAction: "none",
    takesAgentOffline: !waiting,
  };
}

/** A provider's normalized limit is a retryable rate limit, whatever its text says, and an
 * exhausted quota is not retried before its reported reset; any other failure is classified from
 * its text. */
export function classifyRuntimeError(
  event: Pick<
    Extract<AgentRuntimeEvent, { type: "error" }>,
    "message" | "providerLimit" | "httpStatus"
  >,
): RuntimeErrorClassification {
  const limit = event.providerLimit;
  if (!limit) return classifyRuntimeErrorText(event.message, event.httpStatus);
  // An exhausted quota is a wait only when its reset is known. Without one (a monthly quota, or
  // a provider that does not say) no retry can be planned: the Agent goes offline and the user is
  // told why, instead of being held behind a backoff that can never usefully end.
  if (limit.kind === "quota_exhausted")
    return limit.resetsAt
      ? {
          errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
          errorReason: "quota_exhausted",
          retryDecision: RETRY,
          retryNotBefore: limit.resetsAt,
          requiredAction: "none",
          takesAgentOffline: false,
        }
      : {
          errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
          errorReason: "quota_exhausted",
          retryDecision: TERMINAL,
          requiredAction: "none",
          takesAgentOffline: true,
        };
  return {
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "rate_limited",
    retryDecision: RETRY,
    requiredAction: "none",
    takesAgentOffline: false,
  };
}

/** The action a classified failure needs a person to take: re-authentication for every
 * `AuthError`, a model/plan change for a plan-access `ModelConfigError`. */
function classifyRuntimeErrorAction(
  errorClass: RuntimeErrorClass,
  message: string,
): ClassifiedRuntimeErrorAction {
  if (errorClass === RUNTIME_ERROR_CLASS.AUTH) return RUNTIME_ERROR_ACTION.USER_REAUTH;
  if (errorClass === RUNTIME_ERROR_CLASS.MODEL_CONFIG && isRuntimePlanAccessText(message))
    return RUNTIME_ERROR_ACTION.USER_MODEL_ACCESS;
  return "none";
}

/** Classifies a runtime failure from its own text alone (no provider hint involved — see the
 * module comment for why callers that care about a provider's own hint apply it separately). */
export function classifyRuntimeErrorText(
  message: string,
  providerHttpStatus?: number,
): RuntimeErrorClassification {
  const httpStatus = isHttpErrorStatus(providerHttpStatus)
    ? providerHttpStatus
    : extractHttpStatus(message);
  // Billing precedes plan access and the status block (reference order): a 402, or billing
  // wording under any status, is decided by whether the failure names a recovery time.
  if (
    httpStatus === 402 ||
    RUNTIME_BILLING_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(message))
  )
    return billingClassification(httpStatus, message);
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.matches(message, httpStatus)) {
      const requiredAction = classifyRuntimeErrorAction(rule.errorClass, message);
      return {
        errorClass: rule.errorClass,
        ...(httpStatus !== null ? { httpStatus } : {}),
        errorReason: rule.errorReason,
        retryDecision: rule.retryDecision,
        requiredAction,
        takesAgentOffline:
          requiredAction !== "none" ||
          rule.errorClass === RUNTIME_ERROR_CLASS.BILLING ||
          (rule.errorClass === RUNTIME_ERROR_CLASS.MODEL_CONFIG &&
            RUNTIME_OFFLINE_MODEL_PATTERN.test(message)),
      };
    }
  }
  return {
    errorClass: RUNTIME_ERROR_CLASS.RUNTIME,
    errorReason: "runtime_failure",
    retryDecision: RETRY,
    requiredAction: "none",
    takesAgentOffline: false,
  };
}
