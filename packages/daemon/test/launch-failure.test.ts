import { expect, test } from "bun:test";
import { RuntimeLoginRequiredError, RuntimeStartFailedError } from "@lrm/coforge-anvil";
import {
  AgentAuthorizationError,
  isNonRetryableLaunchFailure,
  launchFailureActivity,
  launchFailureTrace,
} from "#src/agent-runtime/launch-failure";
import { AgentConfigRequestError } from "#src/connection/agent-config-request";

test("launchFailureTrace extracts classified launch evidence from a PiLaunchError", () => {
  const error = {
    name: "PiLaunchError",
    policyCode: "PI_LAUNCH_MODEL_MISSING",
    trace: {
      provider: "ollama-cloud",
      providerPresent: true,
      providerKeyPresent: true,
      baseUrlPresent: true,
      modelPresent: false,
    },
  };
  expect(launchFailureTrace(error)).toEqual({
    launchCategory: "PI_LAUNCH_MODEL_MISSING",
    provider: "ollama-cloud",
    providerPresent: true,
    providerKeyPresent: true,
    baseUrlPresent: true,
    modelPresent: false,
  });
});

test("launchFailureTrace is empty for errors without classification evidence", () => {
  expect(launchFailureTrace(new Error("boom"))).toEqual({});
  expect(launchFailureTrace(null)).toEqual({});
  expect(launchFailureTrace("string")).toEqual({});
  expect(launchFailureTrace({ policyCode: null })).toEqual({});
});

test("launchFailureTrace keeps only exactly-typed members", () => {
  expect(
    launchFailureTrace({
      policyCode: 42,
      trace: { provider: "x", providerPresent: "yes" },
    }),
  ).toMatchObject({ provider: "x" });
  // non-string policyCode is dropped; non-boolean booleans collapse to undefined
  expect(
    launchFailureTrace({
      policyCode: 42,
      trace: { provider: "x", providerPresent: "yes" },
    }).launchCategory,
  ).toBeUndefined();
});

test("a runtime that cannot start is its own reason, never read as too old", () => {
  const activity = launchFailureActivity(
    new RuntimeStartFailedError(
      "DeepSeek Harness exited 1 when asked for its version",
      "No version is set for shim: node",
    ),
    "DeepSeek Harness",
  );
  expect(activity.runtimeError.errorReason).toBe("runtime_start_failed");
  // The CLI's own first stderr line is what tells a person what to fix.
  expect(activity.detail).toContain("No version is set for shim: node");
  expect(activity.detail).not.toContain("too old");
});

test("a runtime whose login is not usable names the login as the thing to fix", () => {
  const activity = launchFailureActivity(
    new RuntimeLoginRequiredError("Kiro CLI is not logged in on this Computer"),
    "Kiro CLI",
  );
  expect(activity.runtimeError.errorReason).toBe("runtime_login_required");
  expect(activity.detail).toBe(
    "Kiro CLI needs you to log in on this Computer before it can start. Log in to Kiro CLI " +
      "there, then start the Agent again.",
  );
});

test("only a reason no retry can fix skips the launch retries", () => {
  expect(
    isNonRetryableLaunchFailure(new RuntimeLoginRequiredError("Kiro CLI is not logged in")),
  ).toBe(true);
  const runtimeUnavailable = new AgentAuthorizationError(
    new AgentConfigRequestError(
      "refused",
      403,
      "RUNTIME_UNAVAILABLE",
      "the configured runtime is not available on this Computer",
    ),
  );
  expect(isNonRetryableLaunchFailure(runtimeUnavailable)).toBe(true);

  const networkError = new AgentAuthorizationError(
    new AgentConfigRequestError("network", undefined, undefined, "network timeout"),
  );
  expect(isNonRetryableLaunchFailure(networkError)).toBe(false);

  const serverError = new AgentAuthorizationError(
    new AgentConfigRequestError("server", 503, undefined, "server unavailable"),
  );
  expect(isNonRetryableLaunchFailure(serverError)).toBe(false);

  // Every other reason keeps the same attempts and backoff.
  expect(isNonRetryableLaunchFailure(new RuntimeStartFailedError("exited 1"))).toBe(false);
  expect(isNonRetryableLaunchFailure(new Error("boom"))).toBe(false);
});

test("an authorization failure naming RUNTIME_UNAVAILABLE explains the unavailability and sharing", () => {
  const activity = launchFailureActivity(
    new AgentAuthorizationError(
      new AgentConfigRequestError(
        "refused",
        403,
        "RUNTIME_UNAVAILABLE",
        "the configured runtime is not available on this Computer",
      ),
    ),
    "Kiro",
  );
  expect(activity.runtimeError.errorReason).toBe("runtime_unavailable");
  expect(activity.detail).toContain(
    "The configured runtime is not available on this Computer, or is not shared with this Agent's owner.",
  );
});

test("each refined runtime refusal keeps its own reason and says what to fix", () => {
  const cases = [
    {
      upstream: "RUNTIME_PRIVATE",
      reason: "runtime_private",
      text: "The configured runtime is marked private on this Computer, and is not shared with this Agent's owner.",
    },
    {
      upstream: "RUNTIME_NOT_INSTALLED",
      reason: "runtime_not_installed",
      text: "Kiro is not installed on this Computer. Install Kiro, then start the Agent again.",
    },
    {
      upstream: "RUNTIME_UNUSABLE",
      reason: "runtime_unusable",
      text: "Kiro is not usable on this Computer. Check its status in Computer settings, then start the Agent again.",
    },
  ] as const;
  for (const { upstream, reason, text } of cases) {
    const activity = launchFailureActivity(
      new AgentAuthorizationError(
        new AgentConfigRequestError("refused", 403, upstream, upstream.toLowerCase()),
      ),
      "Kiro",
    );
    expect(activity.runtimeError.errorReason).toBe(reason);
    expect(activity.detail).toContain(text);
  }
});
