import { describe, expect, test } from "bun:test";

import {
  agentReadinessLine,
  launchFailureNeedsRuntime,
  launchFailureReason,
  LAUNCH_FAILURE_FIXABLE,
} from "#src/features/agents/profile-panel/agent-readiness-line";

describe("agentReadinessLine", () => {
  test("ready and unknown states show nothing", () => {
    expect(agentReadinessLine({ state: "ready" })).toBeNull();
    expect(agentReadinessLine({ state: "something_new" })).toBeNull();
  });

  test("each readiness state maps to its own line", () => {
    expect(agentReadinessLine({ state: "computer_updating" })).toBe("computer_updating");
    expect(agentReadinessLine({ state: "computer_offline" })).toBe("computer_offline");
    expect(agentReadinessLine({ state: "runtime_missing" })).toBe("runtime_missing");
    expect(agentReadinessLine({ state: "runtime_login_required" })).toBe("runtime_login_required");
    expect(agentReadinessLine({ state: "launch_failed", detail: "runtime_spawn_failed" })).toBe(
      "launch_failed",
    );
  });

  test("a login errorCode under launch_failed still gets the login line, once", () => {
    expect(agentReadinessLine({ state: "launch_failed", detail: "runtime_login_required" })).toBe(
      "runtime_login_required",
    );
  });
});

describe("launchFailureReason", () => {
  test("known codes keep their own reason", () => {
    expect(launchFailureReason("runtime_not_found")).toBe("runtime_not_found");
    expect(launchFailureReason("runtime_not_installed")).toBe("runtime_not_installed");
    expect(launchFailureReason("auth_failed")).toBe("auth_failed");
    expect(launchFailureReason("agent_authorization_failed")).toBe("agent_authorization_failed");
  });

  test("spawn failure shares the start-failed reason; anything else is generic", () => {
    expect(launchFailureReason("runtime_spawn_failed")).toBe("runtime_start_failed");
    expect(launchFailureReason("launch_failed")).toBe("generic");
    expect(launchFailureReason("start_intent_invalid")).toBe("generic");
    expect(launchFailureReason(null)).toBe("generic");
    expect(launchFailureReason(undefined)).toBe("generic");
  });
});

describe("launch failure presentation facts", () => {
  test("runtime-named reasons need a runtime label; others do not", () => {
    expect(launchFailureNeedsRuntime("runtime_not_installed")).toBeTrue();
    expect(launchFailureNeedsRuntime("model_not_found")).toBeTrue();
    expect(launchFailureNeedsRuntime("auth_failed")).toBeFalse();
    expect(launchFailureNeedsRuntime("generic")).toBeFalse();
  });

  test("only settings-fixable reasons offer the settings action", () => {
    expect(LAUNCH_FAILURE_FIXABLE.has("model_not_found")).toBeTrue();
    expect(LAUNCH_FAILURE_FIXABLE.has("agent_environment_invalid")).toBeTrue();
    expect(LAUNCH_FAILURE_FIXABLE.has("runtime_not_installed")).toBeFalse();
    expect(LAUNCH_FAILURE_FIXABLE.has("generic")).toBeFalse();
  });
});
