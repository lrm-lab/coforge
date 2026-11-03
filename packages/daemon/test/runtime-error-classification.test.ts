import { expect, test } from "bun:test";
import {
  classifyRuntimeError,
  classifyRuntimeErrorText,
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
} from "#src/agent-runtime/runtime-error-classification";

test("classifies a rate-limit message as retryable", () => {
  const result = classifyRuntimeErrorText("You are being rate limited, please slow down");
  expect(result).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "rate_limited",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
    requiredAction: "none",
    takesAgentOffline: false,
  });
});

test("classifies too-many-requests wording as rate limit", () => {
  expect(classifyRuntimeErrorText("429 Too Many Requests").errorClass).toBe(
    RUNTIME_ERROR_CLASS.RATE_LIMIT,
  );
});

test("classifies a provider 5xx as a retryable server error", () => {
  const result = classifyRuntimeErrorText("upstream error: 503 Service Unavailable");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.PROVIDER_SERVER);
  expect(result.errorReason).toBe("provider_server_error");
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.RETRY);
});

test("classifies a connection reset as a retryable provider connection error", () => {
  const result = classifyRuntimeErrorText("connect ECONNRESET 10.0.0.1:443");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.PROVIDER_CONNECTION);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.RETRY);
});

test("classifies an unexpectedly closed stream as a retryable provider stream error", () => {
  const result = classifyRuntimeErrorText("stream closed unexpectedly before completion");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.PROVIDER_STREAM);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.RETRY);
});

test("classifies a generic not-found message as retryable", () => {
  const result = classifyRuntimeErrorText("conversation resource not found");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.NOT_FOUND);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.RETRY);
});

test("classifies a timeout as terminal-for-this-process (retrying will not help)", () => {
  const result = classifyRuntimeErrorText("the request timed out after 60000ms");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.TIMEOUT);
  expect(result.errorReason).toBe("provider_timeout");
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.TERMINAL);
});

test("classifies an auth/login failure as terminal and offline, action user_reauth", () => {
  const result = classifyRuntimeErrorText("Unauthorized: please sign in again");
  expect(result).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.AUTH,
    errorReason: "auth_failed",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.TERMINAL,
    requiredAction: "user_reauth",
    takesAgentOffline: true,
  });
});

test.each([
  "access token could not be refreshed",
  "authentication token has been invalidated",
  "logged out or signed in to another account",
  "missing credentials",
  "invalid api key",
  "api key is not set",
])("auth wording takes the Agent offline for re-authentication: %s", (message) => {
  const result = classifyRuntimeErrorText(message);
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.AUTH);
  expect(result.requiredAction).toBe("user_reauth");
  expect(result.takesAgentOffline).toBe(true);
});

test("Kiro's rejected bearer token is an auth failure under its 403, not a retryable provider error", () => {
  // kiro-cli 2.33.1, 2026-11-01: 403 AccessDeniedException with this message when the stored
  // token is no longer accepted. The status block alone would call a 403 a provider API error.
  const result = classifyRuntimeErrorText(
    "The bearer token included in the request is invalid (403 AccessDeniedException)",
  );
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.AUTH);
  expect(result.requiredAction).toBe("user_reauth");
  expect(result.takesAgentOffline).toBe(true);
});

test("a bare 401 status is an auth failure", () => {
  const result = classifyRuntimeErrorText("request failed with status 401");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.AUTH);
  expect(result.requiredAction).toBe("user_reauth");
});

test("a 403 only counts as auth when its text names an auth failure", () => {
  expect(classifyRuntimeErrorText("HTTP 403: not logged in").errorClass).toBe(
    RUNTIME_ERROR_CLASS.AUTH,
  );
  expect(classifyRuntimeErrorText("HTTP 403: quota per day exceeded").errorClass).not.toBe(
    RUNTIME_ERROR_CLASS.AUTH,
  );
});

test("a plan that does not include the model is ModelConfigError with user_model_access", () => {
  const result = classifyRuntimeErrorText(
    "Your plan does not include access to the configured model",
  );
  expect(result).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.MODEL_CONFIG,
    errorReason: "model_config_error",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.TERMINAL,
    requiredAction: "user_model_access",
    takesAgentOffline: true,
  });
});

const CURSOR_FREE_PLAN_FAILURE =
  "exit code 1 | stderr: ActionRequiredError: Named models unavailable Free plans can only use Auto. " +
  "Upgrade your plan or remove --model to use Auto.";

test("Cursor's free-plan named-model failure is classified as a plan access error", () => {
  expect(classifyRuntimeErrorText(CURSOR_FREE_PLAN_FAILURE)).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.MODEL_CONFIG,
    errorReason: "model_config_error",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.TERMINAL,
    requiredAction: "user_model_access",
    takesAgentOffline: true,
  });
});

test("a plan-access message naming a transient limit is not user_model_access", () => {
  const result = classifyRuntimeErrorText(
    "model is not included in your plan at the moment, try again later",
  );
  expect(result.errorClass).not.toBe(RUNTIME_ERROR_CLASS.MODEL_CONFIG);
  expect(result.requiredAction).toBe("none");
  expect(result.takesAgentOffline).toBe(false);
});

test("an unsupported model is a sticky offline failure without a named action", () => {
  const result = classifyRuntimeErrorText("The requested model is not supported");
  expect(result).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.MODEL_CONFIG,
    errorReason: "model_config_error",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.TERMINAL,
    requiredAction: "none",
    takesAgentOffline: true,
  });
});

test("a missing model is terminal but stays wakeable", () => {
  const result = classifyRuntimeErrorText("model gpt-9 not found");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.MODEL_CONFIG);
  expect(result.requiredAction).toBe("none");
  expect(result.takesAgentOffline).toBe(false);
});

test("classifies an oversized prompt as terminal", () => {
  const result = classifyRuntimeErrorText("input is too large: exceeds the maximum context size");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.INPUT_TOO_LARGE);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.TERMINAL);
});

test("classifies a launcher/spawn failure as terminal", () => {
  const result = classifyRuntimeErrorText("spawn codex ENOENT");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.LAUNCHER);
  expect(result.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.TERMINAL);
});

test("falls back to the generic runtime error class for unrecognized text, treated as retryable", () => {
  const result = classifyRuntimeErrorText("provider request failed");
  expect(result).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.RUNTIME,
    errorReason: "runtime_failure",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
    requiredAction: "none",
    takesAgentOffline: false,
  });
});

test("model-not-found text is model config, not the generic not-found class", () => {
  const result = classifyRuntimeErrorText("model gpt-9 not found");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.MODEL_CONFIG);
});

test("a provider's transient rate limit is a retryable rate limit, whatever its text", () => {
  // The text alone reads as a terminal timeout; the provider's normalized limit wins.
  expect(
    classifyRuntimeError({
      message: "request timed out",
      providerLimit: { kind: "transient_rate_limit" },
    }),
  ).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "rate_limited",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
    requiredAction: "none",
    takesAgentOffline: false,
  });
});

test("an exhausted quota without a reset cannot be retried and takes the Agent offline", () => {
  expect(
    classifyRuntimeError({ message: "limit", providerLimit: { kind: "quota_exhausted" } }),
  ).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "quota_exhausted",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.TERMINAL,
    requiredAction: "none",
    takesAgentOffline: true,
  });
});

test("an exhausted quota with a reported reset time is not retried before it", () => {
  const resetsAt = "2100-01-01T00:00:00.000Z";
  const limit = { kind: "quota_exhausted", resetsAt } as const;
  expect(classifyRuntimeError({ message: "limit", providerLimit: limit }).retryNotBefore).toBe(
    resetsAt,
  );
  // A transient limit's reset, if any, is not a quota's: its backoff stays exponential.
  const transient = { kind: "transient_rate_limit", resetsAt } as const;
  expect(classifyRuntimeError({ message: "limit", providerLimit: transient })).not.toHaveProperty(
    "retryNotBefore",
  );
});

test("an HTTP 402 status is an exhausted billing balance: terminal, offline, no named action", () => {
  expect(classifyRuntimeErrorText("HTTP 402: request failed")).toEqual({
    httpStatus: 402,
    errorClass: RUNTIME_ERROR_CLASS.BILLING,
    errorReason: "billing_exhausted",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.TERMINAL,
    requiredAction: "none",
    takesAgentOffline: true,
  });
});

test("a 402 that names its reset is a wait, not an unrecoverable balance", () => {
  const resetsAt = "2100-01-01T00:00:00Z";
  expect(classifyRuntimeErrorText(`HTTP 402: quota exhausted; resets at ${resetsAt}`)).toEqual({
    httpStatus: 402,
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "quota_exhausted",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
    retryNotBefore: resetsAt,
    requiredAction: "none",
    takesAgentOffline: false,
  });
});

test("a wall-clock reset is not a recovery time this daemon can wait on", () => {
  const result = classifyRuntimeErrorText("HTTP 402: quota exhausted, resets 3:45pm");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.BILLING);
  expect(result.takesAgentOffline).toBe(true);
});

test.each([
  "Payment Required",
  "Your credit balance is too low to access the API",
  "insufficient credits",
  "You have run out of credits",
  // Command Code cli 1.88 submit errors. With no duration and no date these stay offline.
  "Premium credits exhausted",
  "Premium requests used up. Pick a standard model.",
  "Spend limit reached",
  "Usage limit reached",
  "You've reached today's limit on grok-4",
  "You've reached your weekly usage limit",
  "You've hit your usage limit",
  "Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.",
])("billing-exhausted wording is terminal and offline, without a named action: %s", (message) => {
  expect(classifyRuntimeErrorText(message)).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.BILLING,
    errorReason: "billing_exhausted",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.TERMINAL,
    requiredAction: "none",
    takesAgentOffline: true,
  });
});

test("a 402 whose text names plan access is still billing: billing precedes plan access", () => {
  const result = classifyRuntimeErrorText(
    "HTTP 402: your plan does not include access to this model",
  );
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.BILLING);
  expect(result.requiredAction).toBe("none");
});

test("billing wording under another status still wins over the status block", () => {
  const result = classifyRuntimeErrorText("HTTP 429: insufficient balance");
  expect(result.errorClass).toBe(RUNTIME_ERROR_CLASS.BILLING);
  expect(result.errorReason).toBe("billing_exhausted");
});

test("a Command Code usage limit that names an ISO reset waits until then", () => {
  const resetsAt = "2100-01-01T00:00:00Z";
  expect(
    classifyRuntimeErrorText(`You've reached your weekly usage limit. Resets at ${resetsAt}`),
  ).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "quota_exhausted",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
    retryNotBefore: resetsAt,
    requiredAction: "none",
    takesAgentOffline: false,
  });
});

test.each([
  ["3h (3:45pm)", 3 * 60 * 60 * 1000],
  ["45m", 45 * 60 * 1000],
  ["2d 4h", 2 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000],
  ["3h 5m", 3 * 60 * 60 * 1000 + 5 * 60 * 1000],
])(
  "a Command Code duration reset waits that long and ignores the clock: Resets in %s",
  (duration, waitMs) => {
    const started = Date.now();
    const result = classifyRuntimeErrorText(
      `You've reached your weekly usage limit. Resets in ${duration}.`,
    );
    const retryNotBefore = Date.parse(result.retryNotBefore ?? "");
    expect(result).toMatchObject({
      errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
      errorReason: "quota_exhausted",
      retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
      requiredAction: "none",
      takesAgentOffline: false,
    });
    expect(retryNotBefore).toBeGreaterThanOrEqual(started + waitMs);
    expect(retryNotBefore).toBeLessThanOrEqual(Date.now() + waitMs);
  },
);

test("Codex usage limit with a local try-again time waits until then", () => {
  const message = "You've hit your usage limit. Try again at Nov 3, 2100 5:19 PM.";
  expect(classifyRuntimeErrorText(message)).toMatchObject({
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "quota_exhausted",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
    retryNotBefore: new Date(2100, 10, 3, 17, 19, 0, 0).toISOString(),
    requiredAction: "none",
    takesAgentOffline: false,
  });
});

test("Codex try-again-in hours on a usage limit waits that long", () => {
  const started = Date.now();
  const result = classifyRuntimeErrorText("You've hit your usage limit. try again in 5 hours.");
  const retryNotBefore = Date.parse(result.retryNotBefore ?? "");
  expect(result.takesAgentOffline).toBe(false);
  expect(result.errorReason).toBe("quota_exhausted");
  expect(retryNotBefore).toBeGreaterThanOrEqual(started + 5 * 60 * 60 * 1000);
  expect(retryNotBefore).toBeLessThanOrEqual(Date.now() + 5 * 60 * 60 * 1000);
});

test("a session limit is not an exhausted usage quota", () => {
  expect(classifyRuntimeErrorText("You've hit your session limit")).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.RUNTIME,
    errorReason: "runtime_failure",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
    requiredAction: "none",
    takesAgentOffline: false,
  });
});

test("a call-stack failure is not an exhausted quota and stays wakeable", () => {
  expect(classifyRuntimeErrorText("Maximum call stack size exceeded")).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.RUNTIME,
    errorReason: "runtime_failure",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
    requiredAction: "none",
    takesAgentOffline: false,
  });
});

test("without a provider limit, a failure is classified from its text alone", () => {
  for (const message of ["request timed out", "You've hit your session limit", "429"])
    expect(classifyRuntimeError({ message })).toEqual(classifyRuntimeErrorText(message));
});

test("structured status wins over contradictory error text and invalid status falls back", () => {
  expect(
    classifyRuntimeError({ message: "HTTP 500: request failed", httpStatus: 404 }),
  ).toMatchObject({ errorClass: RUNTIME_ERROR_CLASS.NOT_FOUND, httpStatus: 404 });
  expect(classifyRuntimeError({ message: "HTTP 404: missing", httpStatus: NaN })).toMatchObject({
    errorClass: RUNTIME_ERROR_CLASS.NOT_FOUND,
    httpStatus: 404,
  });
});
