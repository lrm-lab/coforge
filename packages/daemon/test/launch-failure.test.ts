import { expect, test } from "bun:test";
import { RuntimeStartFailedError } from "@lrm/coforge-anvil";
import { launchFailureActivity, launchFailureTrace } from "#src/agent-runtime/launch-failure";

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
