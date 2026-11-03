import {
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
  type RuntimeErrorClass,
  type RuntimeErrorRetryDecision,
} from "./runtime-error-vocabulary";

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
  // Kiro's rejected login: `The bearer token included in the request is invalid` (403
  // AccessDeniedException, or a 401 UnauthorizedException), which the short window above misses.
  /\bbearer token\b[^.\n]{0,80}\b(?:invalid|expired|missing)\b/i,
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
export const RUNTIME_BILLING_EXHAUSTED_PATTERNS = [
  /\bpayment required\b/i,
  /\b(?:usage|credit|account)\s+balance\b[^.]*\b(?:exhausted|depleted|insufficient|too low)\b/i,
  /\binsufficient\s+(?:balance|credits?|funds)\b/i,
  /\b(?:out of|run out of|no remaining)\s+credits?\b/i,
  // Command Code's own submit errors (cli 1.88). A reset instant, when present, is quotaResetAt.
  /\bpremium credits exhausted\b/i,
  /\bpremium requests used up\b/i,
  /\bspend limit reached\b/i,
  /\busage limit reached\b/i,
  /\byou(?:'|’)ve reached\b[^.]{0,80}\b(?:usage limit|today's limit)\b/i,
];

/** A sticky model-config failure takes the Agent offline even without a named action — mirrored
 * from the reference Computer's `classifyStickyTerminalFailure` model wording. Other model
 * failures ("model not found") stay terminal-but-wakeable. */
export const RUNTIME_OFFLINE_MODEL_PATTERN =
  /\b(?:model\b.*\bnot supported|unsupported\b.*\bmodel)\b/i;

/** An HTTP status the failure text itself names: "HTTP 401", "status code: 429",
 * "API Error 503", "401 Unauthorized" or "401:" — mirrored from the reference Computer's
 * `extractHttpStatus`. */
export function extractHttpStatus(message: string): number | null {
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

/** A provider that names when an exhausted quota resets, as an ISO-8601 UTC instant. Only an
 * explicit, unambiguous instant counts: "resets 3:45pm" is a wall-clock guess this daemon cannot
 * wait on, and a monthly quota usually names nothing. */
const QUOTA_RESET_TIME =
  /\bresets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/i;

export function quotaResetAt(message: string): string | undefined {
  const value = QUOTA_RESET_TIME.exec(message)?.[1];
  return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** Ordered rules: the first one whose pattern matches wins. The sequence mirrors the reference
 * Computer's `classifyRuntimeError` for the classes this module shares: billing ahead of plan
 * access, plan access ahead of status codes, status codes ahead of auth and model text. Its
 * `explicit` provider error-name passthrough and its `OperationAbortedError` class have no
 * equivalent here yet. */
export const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
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
