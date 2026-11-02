/**
 * The stable error classes and retry decisions `runtime-error-classification.ts` reads. They live
 * here so the classification's pattern table (`runtime-error-rules.ts`) can name them without a
 * cycle; the classification module re-exports both for its callers.
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
