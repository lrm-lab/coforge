import { expect, test } from "bun:test";
import {
  classifyRuntimeErrorText,
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
} from "#src/agent-runtime/runtime-error-classification";

test("Antigravity's individual quota wording classifies as a retryable window limit", () => {
  const classified = classifyRuntimeErrorText(
    "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h30m.",
  );
  expect(classified.errorClass).toBe(RUNTIME_ERROR_CLASS.RATE_LIMIT);
  expect(classified.errorReason).toBe("quota_exhausted");
  expect(classified.retryDecision).toBe(RUNTIME_ERROR_RETRY_DECISION.RETRY);
  expect(classified.takesAgentOffline).toBe(false);
});
