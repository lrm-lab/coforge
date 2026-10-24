import { describe, expect, test } from "bun:test";
import {
  buildRuntimeErrorActivity,
  buildRuntimeCrashedActivity,
  buildRuntimeErrorFingerprintFenceActivity,
  buildRuntimeReconnectingActivity,
  fingerprintRuntimeError,
  type RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import { scrubRuntimeErrorText } from "#src/code-agent/runtime-error-text";

test("builds a runtime_error activity from the provider's message as reported, with an Error: entry and structured fields", () => {
  const long = "x".repeat(600);
  const activity = buildRuntimeErrorActivity({
    type: "error",
    message: `request timed out ${long}`,
  });
  expect(activity.detailKind).toBe("runtime_error");
  expect(activity.level).toBe("error");
  expect(activity.detail).toBe(`request timed out ${long}`);
  expect(activity.entries).toEqual([{ kind: "text", text: `Error: ${activity.detail}` }]);
  // No provider hint was given, so the daemon's own text classification fills errorClass/
  // errorReason (runtime-error-classification.ts) instead of the old generic default.
  expect(activity.runtimeError).toMatchObject({
    errorClass: "TimeoutError",
    errorReason: "provider_timeout",
  });
  expect(activity.runtimeError!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
});

test("falls back to the generic class/reason when no provider hint and no text pattern matches", () => {
  const activity = buildRuntimeErrorActivity({
    type: "error",
    message: "provider request failed",
  });
  expect(activity.runtimeError).toMatchObject({
    errorClass: "AgentRuntimeError",
    errorReason: "runtime_failure",
  });
});

test("prefers provider-supplied error class/code/reason hints when present", () => {
  const activity = buildRuntimeErrorActivity({
    type: "error",
    message: "turn failed",
    providerErrorClass: "invalid_request",
    providerErrorReason: "turn_failed",
  });
  expect(activity.runtimeError).toMatchObject({
    errorClass: "invalid_request",
    errorReason: "turn_failed",
  });
});

test("falls back to providerErrorCode for errorClass when no providerErrorClass is given", () => {
  const activity = buildRuntimeErrorActivity({
    type: "error",
    message: "turn failed",
    providerErrorCode: "-32600",
  });
  expect(activity.runtimeError!.errorClass).toBe("-32600");
});

test("uses occurredAt when the provider supplies it, else the current time", () => {
  const occurredAt = "2026-09-17T00:00:00.000Z";
  const activity = buildRuntimeErrorActivity({ type: "error", message: "boom", occurredAt });
  expect(activity.observedAtMs).toBe(Date.parse(occurredAt));
  const now = buildRuntimeErrorActivity({ type: "error", message: "boom" });
  expect(now.observedAtMs).toBeGreaterThan(0);
});

test("two error events with the same message fingerprint identically", () => {
  const a = buildRuntimeErrorActivity({ type: "error", message: "timeout after 30s" });
  const b = buildRuntimeErrorActivity({ type: "error", message: "timeout after 30s" });
  expect(a.runtimeError!.fingerprint).toBe(b.runtimeError!.fingerprint);
});

test("builds a runtime_crashed activity from the last unresolved error, with Crashed(...) wording", () => {
  const activity = buildRuntimeCrashedActivity({
    type: "error",
    message: "code agent process exited unexpectedly",
  });
  expect(activity.detailKind).toBe("runtime_crashed");
  expect(activity.level).toBe("error");
  expect(activity.detail).toBe("Crashed (code agent process exited unexpectedly)");
  expect(activity.entries).toEqual([
    { kind: "text", text: "Error: Crashed (code agent process exited unexpectedly)" },
  ]);
  expect(activity.runtimeError!.errorReason).toBe("runtime_crashed");
});

test("redacts the crashed message too", () => {
  const activity = buildRuntimeCrashedActivity({
    type: "error",
    message: "Bearer sk-fixture-private-token",
  });
  expect(activity.detail).not.toContain("sk-fixture-private-token");
});

test("builds a runtime_reconnecting activity with a default message when the provider gives none", () => {
  const withMessage = buildRuntimeReconnectingActivity({
    type: "reconnecting",
    attempt: 2,
    message: "Reconnecting... 2/5",
  });
  expect(withMessage).toMatchObject({
    detailKind: "runtime_reconnecting",
    level: "info",
    detail: "Reconnecting... 2/5",
    entries: [{ kind: "text", text: "Reconnecting... 2/5" }],
  });
  const withoutMessage = buildRuntimeReconnectingActivity({ type: "reconnecting" });
  expect(withoutMessage.detail).toBe("Reconnecting to provider…");
});

test("shows the provider retry attempt, backoff and original failure without a terminal error", () => {
  const activity = buildRuntimeReconnectingActivity({
    type: "reconnecting",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 4000,
    message: "server_busy",
  });
  expect(activity).toMatchObject({
    detailKind: "runtime_reconnecting",
    level: "info",
    detail: "Retrying provider request (attempt 2/3, backoff 4s): server_busy",
    entries: [
      { kind: "text", text: "Retrying provider request (attempt 2/3, backoff 4s): server_busy" },
    ],
  });
  expect(activity.runtimeError).toBeUndefined();
});

test.each([
  [{ delayMs: 2000 }, "Retrying provider request (backoff 2s)"],
  [{ delayMs: 2000, attempt: 1 }, "Retrying provider request (attempt 1, backoff 2s)"],
] as const)("retry wording omits unknown attempt facts: %j", (facts, detail) => {
  expect(buildRuntimeReconnectingActivity({ type: "reconnecting", ...facts }).detail).toBe(detail);
});

test("scrubRuntimeErrorText redacts tokens/secrets/Bearer and caps at 512 chars", () => {
  expect(scrubRuntimeErrorText("password=hunter2 rest")).toBe("password=[REDACTED] rest");
  expect(scrubRuntimeErrorText("Bearer abc.def")).toBe("Bearer [REDACTED]");
  expect(scrubRuntimeErrorText("sk-abcdef123456")).toBe("[REDACTED]");
  expect(scrubRuntimeErrorText("x".repeat(600)).length).toBe(512);
});

test("fingerprintRuntimeError is a stable 8-hex-character hash", () => {
  expect(fingerprintRuntimeError("same")).toBe(fingerprintRuntimeError("same"));
  expect(fingerprintRuntimeError("same")).not.toBe(fingerprintRuntimeError("different"));
  expect(fingerprintRuntimeError("same")).toMatch(/^[0-9a-f]{8}$/);
});

describe("a provider's usage limit", () => {
  const message = "You've hit your session limit · resets 3:45pm";
  const resetsAt = "2100-01-01T00:00:00.000Z";
  const limitError = (providerLimit: RuntimeErrorEvent["providerLimit"]) =>
    ({ type: "error", message, providerErrorCode: "rate_limit", providerLimit }) as const;

  test("an exhausted quota with a reset is a RateLimitError saying when the limit resets", () => {
    const activity = buildRuntimeErrorActivity(limitError({ kind: "quota_exhausted", resetsAt }));
    const detail = `${message} (limit resets at ${resetsAt})`;
    expect(activity.detail).toBe(detail);
    expect(activity.entries).toEqual([{ kind: "text", text: `Error: ${detail}` }]);
    expect(activity.runtimeError).toMatchObject({
      errorClass: "RateLimitError",
      errorReason: "quota_exhausted",
    });
  });

  test("the reset time never changes the fingerprint", () => {
    const fingerprints = [
      limitError({ kind: "quota_exhausted", resetsAt }),
      limitError({ kind: "quota_exhausted", resetsAt: "2100-01-02T00:00:00.000Z" }),
      limitError({ kind: "quota_exhausted" }),
    ].map((event) => buildRuntimeErrorActivity(event).runtimeError?.fingerprint);
    expect(new Set(fingerprints)).toEqual(new Set([fingerprintRuntimeError(message)]));
  });

  test.each([
    ["an exhausted quota without a reset", { kind: "quota_exhausted" }, "quota_exhausted"],
    ["a transient rate limit", { kind: "transient_rate_limit", resetsAt }, "rate_limited"],
  ] as const)("%s shows the provider text alone, classified %s", (_kind, limit, reason) => {
    const activity = buildRuntimeErrorActivity(limitError(limit));
    expect(activity.detail).toBe(message);
    expect(activity.runtimeError).toMatchObject({
      errorClass: "RateLimitError",
      errorReason: reason,
    });
  });

  test("a fenced repeat of it names the provider text alone, without the reset", () => {
    const failed = limitError({ kind: "quota_exhausted", resetsAt });
    const built = buildRuntimeErrorActivity(failed);
    const fingerprint = built.runtimeError?.fingerprint ?? "";
    const fence = { fingerprint, attempts: 3, fenced: true };
    const fenced = buildRuntimeErrorFingerprintFenceActivity(built, fence, failed);
    expect(fenced.detail).toContain(`Last error: ${message} Restart`);
    expect(fenced.detail).not.toContain("limit resets at");
    expect(fenced.entries).toEqual([{ kind: "text", text: `Error: ${fenced.detail}` }]);
    expect(fenced.runtimeError).toMatchObject({ errorReason: "runtime_error_fenced" });
  });

  test("a crash after it is classed from the limit, with the reset left out of its wording", () => {
    const crashed = limitError({ kind: "quota_exhausted", resetsAt });
    const activity = buildRuntimeCrashedActivity(crashed);
    expect(activity.detail).toBe(`Crashed (${message})`);
    expect(activity.runtimeError).toEqual({
      errorClass: "RateLimitError",
      errorReason: "runtime_crashed",
      fingerprint: fingerprintRuntimeError(`Crashed (${message})`),
    });
  });
});
