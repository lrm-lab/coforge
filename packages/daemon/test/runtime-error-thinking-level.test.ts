import { expect, test } from "bun:test";
import { buildRuntimeErrorActivity } from "#src/agent-runtime/runtime-error-activity";
import {
  classifyRuntimeErrorText,
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
} from "#src/agent-runtime/runtime-error-classification";

const REFUSAL = "INVALID_ARGUMENT (code 400): Thinking level is unsupported: THINKING_LEVEL_XHIGH";

test("agy's refused thinking level is a sticky offline model-config failure", () => {
  expect(classifyRuntimeErrorText(REFUSAL)).toEqual({
    errorClass: RUNTIME_ERROR_CLASS.MODEL_CONFIG,
    errorReason: "model_config_error",
    retryDecision: RUNTIME_ERROR_RETRY_DECISION.TERMINAL,
    requiredAction: "none",
    takesAgentOffline: true,
  });
});

test("a refused thinking level says to change the model or level and start the Agent again", () => {
  expect(buildRuntimeErrorActivity({ type: "error", message: REFUSAL }).detail).toBe(
    `${REFUSAL} This model does not support the selected thinking level. Change the model or the thinking level, save, then start the Agent again.`,
  );
  expect(buildRuntimeErrorActivity({ type: "error", message: "model is overloaded" }).detail).toBe(
    "model is overloaded",
  );
});
