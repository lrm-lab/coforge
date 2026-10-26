import { isHttpErrorStatus } from "@lrm/coforge-anvil";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { RUNTIME_ERROR_ACTION, type RuntimeErrorAction } from "@lrm/coforge-sdk/internal";

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
 * action-required failure (`requiredAction` other than `none`), an exhausted billing balance,
 * or a sticky model-config failure
 * ends the process and reports the Agent `inactive` until a person fixes the cause and starts it
 * again. `TimeoutError` stays terminal-but-wakeable deliberately: a timeout is handled by the
 * stall watchdog (a stuck provider needs a kill/restart, not a redelivered message), and
 * `takesAgentOffline` must not attach offline semantics to it.
 */

export const RUNTIME_ERROR_CLASS = {
  LAUNCHER: "LauncherError",
  INPUT_TOO_LARGE: "InputTooLargeError",
  BILLING: "BillingError",
  AUTH: "AuthError",
  MODEL_CONFIG: "ModelConfigError",
  TIMEOUT: "TimeoutError",
  PROVIDER_CONNECTION: "ProviderConnectionError",
  PROVIDER_STREAM: "ProviderStreamError",
  RATE_LIMIT: "RateLimitError",
  PROVIDER_SERVER: "ProviderServerError",
  /** A 4xx the more specific rules did not claim (e.g. 403 without auth wording): retryable,
   * matching the reference Computer's `ProviderApiError`. */
  PROVIDER_API: "ProviderApiError",
  NOT_FOUND: "NotFoundError",
  /** Nothing below matched: keeps the pre-existing default identifier so a caller that already
   * special-cased "AgentRuntimeError"/"runtime_failure" (e.g. existing tests, dashboards) sees no
   * change for text this table still cannot explain. */
  RUNTIME: "AgentRuntimeError",
} as const;
export type RuntimeErrorClass = (typeof RUNTIME_ERROR_CLASS)[keyof typeof RUNTIME_ERROR_CLASS];

export { RUNTIME_ERROR_ACTION };
/** The action only a person can take before the Agent can work again, or `"none"` — the wire
 * vocabulary lives in `@lrm/coforge-sdk` (`runtime_error_action`); "none" never crosses it. */
export type ClassifiedRuntimeErrorAction = RuntimeErrorAction | "none";

export const RUNTIME_ERROR_RETRY_DECISION = {
  /** Worth holding queued deliveries for and re-attempting after a backoff (see
   * `runtime-error-recovery.ts`). */
  RETRY: "retry",
  /**
   * Do not hold a delivery behind a backoff for this occurrence. When `takesAgentOffline` is also
   * set the daemon ends the process and reports the Agent inactive; otherwise the Agent stays
   * wakeable (a `TimeoutError`, for example, is left to the stall watchdog — a stuck provider
   * needs a kill/restart, not a redelivered message).
   */
  TERMINAL: "terminal",
} as const;
export type RuntimeErrorRetryDecision =
  (typeof RUNTIME_ERROR_RETRY_DECISION)[keyof typeof RUNTIME_ERROR_RETRY_DECISION];

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

/** The provider plan does not include the configured model — never a transient capacity limit.
 * Mirrored from the reference Computer's `RUNTIME_PLAN_ACCESS_PATTERNS`, plus Cursor's own
 * free-plan wording ("Named models unavailable Free plans can only use Auto"). */
const RUNTIME_PLAN_ACCESS_PATTERNS = [
  /\b(?:subscription|plan|tier)\b[^\n.]{0,80}\b(?:does not|doesn't|do not|don't|not)\b[^\n.]{0,40}\b(?:include|allow|support|grant)\b[^\n.]{0,40}\b(?:access|model)\b/i,
  /\b(?:model|access)\b[^\n.]{0,80}\b(?:not|isn't|is not)\b[^\n.]{0,20}\b(?:included|available|enabled|allowed)\b[^\n.]{0,40}\b(?:subscription|plan|tier)\b/i,
  /\bnamed models? unavailable\b[^\n]{0,40}\bfree plans?\b[^\n.]{0,40}\bonly use\b/i,
];

/** Wording that marks an apparently plan-shaped message as a transient limit instead —
 * mirrored from the reference Computer's `RUNTIME_TRANSIENT_LIMIT_MARKERS`. */
const RUNTIME_TRANSIENT_LIMIT_MARKERS = [
  /\brate.?limit/i,
  /\btoo many requests\b/i,
  /\bconcurrenc(?:y|ies)\b/i,
  /\bretry(?:ing)?\b/i,
  /\btry again\b/i,
  /\blater\b/i,
  /\bresets?\b/i,
  /\bper (?:second|minute|hour|day)\b/i,
  /\b[RT]PM\b/,
  /\bat the moment\b/i,
  /\bright now\b/i,
  /\bat capacity\b/i,
];

export function isRuntimePlanAccessText(text: string): boolean {
  if (RUNTIME_TRANSIENT_LIMIT_MARKERS.some((pattern) => pattern.test(text))) return false;
  return RUNTIME_PLAN_ACCESS_PATTERNS.some((pattern) => pattern.test(text));
}

/** Auth failure wording that only a person's re-authentication fixes. The union of CoForge's
 * original set and the reference Computer's `RUNTIME_AUTH_ACTION_REQUIRED_PATTERNS`. */
const RUNTIME_AUTH_PATTERNS = [
  /\bunauthorized\b/i,
  /\bunauthenticated\b/i,
  /\bnot logged in\b/i,
  /\bnot signed in\b/i,
  /\bplease (?:sign|log) in\b/i,
  /\bsession expired\b/i,
  /\b(?:api key|token)\b[^.]{0,20}\b(?:invalid|expired|missing)\b/i,
  /\bre-?authenticate\b/i,
  /\bauthentication failed\b/i,
  /\bauth(?:entication)? failed\b/i,
  /\blogin required\b/i,
  /\blog in first\b/i,
  /\baccess token could not be refreshed\b/i,
  /\btoken_(?:revoked|invalidated)\b/i,
  /\brefresh token was already used\b/i,
  /\baccess token.*invalidated\b/i,
  /\bauthentication token has been invalidated\b/i,
  /\blogged out or signed in to another account\b/i,
  /\bauthentication timed out\b/i,
  /\bmissing (?:api )?token\b/i,
  /\bno (?:api )?token\b/i,
  /\bmissing credentials\b/i,
  /\bcredentials? not found\b/i,
  /\bno credentials\b/i,
  /\binvalid api key\b/i,
  /\bapi key (?:is )?not set\b/i,
];

/** An exhausted provider billing/credit balance — no retry can succeed until it is restored,
 * so the failure is terminal and takes the Agent offline. Mirrored from the reference
 * Computer's `RUNTIME_BILLING_EXHAUSTED_PATTERNS` (matched together with HTTP status 402). */
const RUNTIME_BILLING_EXHAUSTED_PATTERNS = [
  /\bpayment required\b/i,
  /\b(?:usage|credit|account)\s+balance\b[^.]*\b(?:exhausted|depleted|insufficient|too low)\b/i,
  /\binsufficient\s+(?:balance|credits?|funds)\b/i,
  /\b(?:out of|run out of|no remaining)\s+credits?\b/i,
];

/** A sticky model-config failure takes the Agent offline even without a named action — mirrored
 * from the reference Computer's `classifyStickyTerminalFailure` model wording. Other model
 * failures ("model not found") stay terminal-but-wakeable. */
const RUNTIME_OFFLINE_MODEL_PATTERN = /\b(?:model\b.*\bnot supported|unsupported\b.*\bmodel)\b/i;

/** An HTTP status the failure text itself names: "HTTP 401", "status code: 429",
 * "API Error 503", "401 Unauthorized" or "401:" — mirrored from the reference Computer's
 * `extractHttpStatus`. */
function extractHttpStatus(message: string): number | null {
  const match =
    /\b(?:HTTP|status(?:\s+code)?|API\s+Error)[:\s]+([45]\d{2})\b/i.exec(message) ??
    /\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Service Unavailable)\b/i.exec(
      message,
    ) ??
    /\b([45]\d{2})\s*:/i.exec(message);
  return match ? Number(match[1]) : null;
}

type ClassificationRule = Readonly<{
  errorClass: RuntimeErrorClass;
  errorReason: string;
  retryDecision: RuntimeErrorRetryDecision;
  matches: (message: string, httpStatus: number | null) => boolean;
}>;

const { RETRY, TERMINAL } = RUNTIME_ERROR_RETRY_DECISION;

/** Ordered rules: the first one whose pattern matches wins. The sequence mirrors the reference
 * Computer's `classifyRuntimeError` for the classes this module shares: billing ahead of plan
 * access, plan access ahead of status codes, status codes ahead of auth and model text. Its
 * `explicit` provider error-name passthrough and its `OperationAbortedError` class have no
 * equivalent here yet. */
const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  {
    errorClass: RUNTIME_ERROR_CLASS.LAUNCHER,
    errorReason: "launcher_error",
    retryDecision: TERMINAL,
    matches: (message) =>
      /\b(?:ENOENT|EACCES|EPERM)\b/.test(message) ||
      /\bfailed to (?:spawn|launch|execute|start)\b/i.test(message) ||
      /\bcommand not found\b/i.test(message) ||
      /\bno such file or directory\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.INPUT_TOO_LARGE,
    errorReason: "input_too_large",
    retryDecision: TERMINAL,
    matches: (message) =>
      /\binput (?:is )?too large\b/i.test(message) ||
      /\bexceeds? the maximum\b/i.test(message) ||
      /\b(?:context (?:length|window)|prompt)\b[^.]{0,40}\b(?:exceed|too long)/i.test(message) ||
      /\btoo many tokens\b/i.test(message),
  },
  {
    // Billing precedes plan access and the status block (reference order): a 402, or billing
    // wording under any status, is an exhausted balance, never a plan or rate-limit failure.
    errorClass: RUNTIME_ERROR_CLASS.BILLING,
    errorReason: "billing_exhausted",
    retryDecision: TERMINAL,
    matches: (message, httpStatus) =>
      httpStatus === 402 ||
      RUNTIME_BILLING_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(message)),
  },
  {
    // Plan access is a model-config failure ahead of any status or auth wording its text mixes in.
    errorClass: RUNTIME_ERROR_CLASS.MODEL_CONFIG,
    errorReason: "model_config_error",
    retryDecision: TERMINAL,
    matches: (message) => isRuntimePlanAccessText(message),
  },
  {
    // The status block precedes auth and model wording (reference order): a statused failure is
    // classified by its code, whatever the text around it says.
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "rate_limited",
    retryDecision: RETRY,
    matches: (_message, httpStatus) => httpStatus === 429,
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.AUTH,
    errorReason: "auth_failed",
    retryDecision: TERMINAL,
    matches: (message, httpStatus) =>
      httpStatus === 401 ||
      (httpStatus === 403 && RUNTIME_AUTH_PATTERNS.some((pattern) => pattern.test(message))),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.NOT_FOUND,
    errorReason: "not_found",
    retryDecision: RETRY,
    matches: (_message, httpStatus) => httpStatus === 404,
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.PROVIDER_SERVER,
    errorReason: "provider_server_error",
    retryDecision: RETRY,
    matches: (_message, httpStatus) => httpStatus !== null && httpStatus >= 500,
  },
  {
    // Any other statused failure is a generic provider API error and stays retryable.
    errorClass: RUNTIME_ERROR_CLASS.PROVIDER_API,
    errorReason: "provider_api_error",
    retryDecision: RETRY,
    matches: (_message, httpStatus) => httpStatus !== null,
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.AUTH,
    errorReason: "auth_failed",
    retryDecision: TERMINAL,
    matches: (message) => RUNTIME_AUTH_PATTERNS.some((pattern) => pattern.test(message)),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.MODEL_CONFIG,
    errorReason: "model_config_error",
    retryDecision: TERMINAL,
    matches: (message) =>
      /\bmodel\b[^.]{0,40}\b(?:not supported|unsupported|not available|not found|does not exist)\b/i.test(
        message,
      ) || /\bunsupported\b[^.]{0,40}\bmodel\b/i.test(message),
  },
  {
    // TERMINAL here means only "no delivery backoff" (see RUNTIME_ERROR_RETRY_DECISION.TERMINAL's
    // own doc) — a hung provider needs a kill/restart, not a redelivered message.
    errorClass: RUNTIME_ERROR_CLASS.TIMEOUT,
    errorReason: "provider_timeout",
    retryDecision: TERMINAL,
    matches: (message) => /\b(?:timed out|timeout|ETIMEDOUT)\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.PROVIDER_CONNECTION,
    errorReason: "provider_connection_error",
    retryDecision: RETRY,
    matches: (message) =>
      /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN)\b/.test(message) ||
      /\bconnection (?:reset|refused|closed|failed)\b/i.test(message) ||
      /\bunable to connect\b/i.test(message) ||
      /\bnetwork (?:error|unreachable)\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.PROVIDER_STREAM,
    errorReason: "provider_stream_error",
    retryDecision: RETRY,
    matches: (message) =>
      /\bstream\b[^.]{0,20}\b(?:closed|ended|terminated)\b[^.]{0,20}\bunexpectedly\b/i.test(
        message,
      ) ||
      /\berror decoding\b.*\bresponse\b/i.test(message) ||
      /\bincomplete (?:response|stream)\b/i.test(message) ||
      /\bpremature (?:close|end)\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "rate_limited",
    retryDecision: RETRY,
    matches: (message) =>
      /\b(?:selected\s+)?model\s+is\s+at\s+capacity\b/i.test(message) ||
      /\brate.?limit(?:ed|ing)?\b/i.test(message) ||
      /\btoo many requests\b/i.test(message) ||
      /\b429\b/.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.PROVIDER_SERVER,
    errorReason: "provider_server_error",
    retryDecision: RETRY,
    matches: (message) =>
      /\b5\d{2}\b/.test(message) ||
      /\b(?:internal server|upstream|provider) error\b/i.test(message) ||
      /\bservice unavailable\b/i.test(message) ||
      /\bbad gateway\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.NOT_FOUND,
    errorReason: "not_found",
    retryDecision: RETRY,
    matches: (message) => /\bnot found\b/i.test(message),
  },
];

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
  const quota = limit.kind === "quota_exhausted";
  return {
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: quota ? "quota_exhausted" : "rate_limited",
    retryDecision: RETRY,
    requiredAction: "none",
    takesAgentOffline: false,
    ...(quota && limit.resetsAt ? { retryNotBefore: limit.resetsAt } : {}),
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
