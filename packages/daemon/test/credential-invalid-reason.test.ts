import { expect, test } from "bun:test";
import { credentialInvalidReason } from "#src/agent-runtime/credential-invalid";
import {
  classifyRuntimeError,
  classifyRuntimeErrorText,
} from "#src/agent-runtime/runtime-error-classification";

test.each([
  ["not logged in", "user_reauth"],
  ["Your plan does not include access to this model", "user_model_access"],
  ["HTTP 402 Payment Required: insufficient balance", "BillingError"],
] as const)("%s is a known-invalid credential: %s", (message, reason) => {
  expect(credentialInvalidReason(classifyRuntimeErrorText(message))).toBe(reason);
});

test.each([
  ["a sticky model-config failure", "The requested model is not supported"],
  ["a rate limit", "429 Too Many Requests"],
  ["a provider connection error", "connect ECONNRESET"],
])("%s is not: its own path decides what it holds", (_name, message) => {
  expect(credentialInvalidReason(classifyRuntimeErrorText(message))).toBeUndefined();
});

test("a quota with no known reset still takes the Agent offline, as no credential is at fault", () => {
  const classification = classifyRuntimeError({
    message: "quota",
    providerLimit: { kind: "quota_exhausted" },
  });
  expect(classification.takesAgentOffline).toBe(true);
  expect(credentialInvalidReason(classification)).toBeUndefined();
});
