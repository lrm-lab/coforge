import { expect, test } from "bun:test";
import {
  RuntimeLoginRequiredError,
  RuntimeMemoryUnsupportedError,
  RuntimeStartFailedError,
} from "@lrm/coforge-anvil";
import {
  AgentAuthorizationError,
  isNonRetryableLaunchFailure,
  launchFailureActivity,
  launchFailureLogFields,
  launchFailureReason,
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

test("a start whose own words refuse the credential is a sign-in, not a launch to retry", () => {
  // The typed login error covers only the providers whose adapter can read their own sign-in
  // state; the rest arrive as a start failure carrying the provider's refusal (task #39).
  const rejected = new RuntimeStartFailedError(
    "claude exited 1 before it was ready",
    "Invalid API key · Please run /login",
  );
  expect(launchFailureReason(rejected)).toBe("runtime_login_required");
  expect(isNonRetryableLaunchFailure(rejected)).toBe(true);
  // The Activity then says what a person does about it, not just that the launch failed.
  expect(launchFailureActivity(rejected, "Claude Code").detail).toContain("log in");

  const unauthorized = new Error("401 Unauthorized: invalid api key provided");
  expect(launchFailureReason(unauthorized)).toBe("runtime_login_required");
  expect(isNonRetryableLaunchFailure(unauthorized)).toBe(true);

  // Words that name no refused credential leave the generic reason and its retries alone.
  const crashed = new RuntimeStartFailedError(
    "claude exited 1 before it was ready",
    "segmentation fault",
  );
  expect(launchFailureReason(crashed)).toBe("runtime_start_failed");
  expect(isNonRetryableLaunchFailure(crashed)).toBe(false);
});

test("a typed reason outranks any wording beside it", () => {
  // A provider that says why in a typed error is never second-guessed by its own text: only a
  // reason that named no cause is read for a refused credential.
  const memoryUnsupported = new RuntimeMemoryUnsupportedError(
    "Unauthorized: this runtime cannot run a Memory Agent",
  );
  expect(launchFailureReason(memoryUnsupported)).toBe("runtime_memory_unsupported");
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

  // A runtime that cannot host a Memory Agent is a person-changes-something failure, not a retry.
  const memoryUnsupported = new RuntimeMemoryUnsupportedError("Cursor cannot run a Memory Agent");
  expect(memoryUnsupported.code).toBe("runtime_memory_unsupported");
  expect(isNonRetryableLaunchFailure(memoryUnsupported)).toBe(true);

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

test("a launch failure carries the runtime's scrubbed message as providerMessage", () => {
  const activity = launchFailureActivity(
    new RuntimeLoginRequiredError("Kiro CLI is not logged in on this Computer"),
    "Kiro CLI",
  );
  expect(activity.runtimeError.providerMessage).toBe("Kiro CLI is not logged in on this Computer");
});

test("a not-installed launch failure carries the refusal text as providerMessage", () => {
  const activity = launchFailureActivity(
    new AgentAuthorizationError(
      new AgentConfigRequestError("refused", 403, "RUNTIME_NOT_INSTALLED", "runtime_not_installed"),
    ),
    "Kiro",
  );
  expect(activity.runtimeError.errorReason).toBe("runtime_not_installed");
  expect(activity.runtimeError.providerMessage).toContain("could not be obtained");
});

test("providerMessage redacts credentials before it leaves the Computer", () => {
  const activity = launchFailureActivity(
    new RuntimeLoginRequiredError("login failed with token=sk-live-secret-123"),
    "Kiro CLI",
  );
  expect(activity.runtimeError.providerMessage).not.toContain("sk-live-secret-123");
  expect(activity.runtimeError.providerMessage).toContain("[REDACTED]");
});

test("an unclassified launch failure carries no providerMessage", () => {
  const activity = launchFailureActivity(
    new RuntimeStartFailedError("spawn failed: /internal/path leaked detail"),
    "Kiro CLI",
  );
  expect(activity.runtimeError.errorReason).toBe("runtime_start_failed");
  expect(activity.runtimeError.providerMessage).toBeUndefined();
});

test("a refused launch writes the server's own code beside the failure", () => {
  const refused = new AgentAuthorizationError(
    new AgentConfigRequestError(
      "refused",
      403,
      "AGENT_LAUNCH_SUPERSEDED",
      "Agent launch config request failed (403): Stale Agent launch",
    ),
  );
  expect(launchFailureLogFields(refused)).toMatchObject({
    failure_reason: "agent_authorization_failed",
    upstream_code: "AGENT_LAUNCH_SUPERSEDED",
  });
  // A server that sends no code (an older one) adds no field, rather than an empty one.
  const uncoded = new AgentAuthorizationError(
    new AgentConfigRequestError("refused", 403, undefined, "Agent launch config request failed"),
  );
  expect(launchFailureLogFields(uncoded)).not.toHaveProperty("upstream_code");
});
