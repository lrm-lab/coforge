import { expect, test } from "bun:test";
import {
  classifyRuntimeErrorText,
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
} from "#src/agent-runtime/runtime-error-classification";

test("a stream closed before response.completed is a provider stream failure, and it retries", () => {
  for (const message of [
    "stream closed before response.completed",
    "Error: stream closed before response.completed",
    "error decoding response body",
  ])
    expect(classifyRuntimeErrorText(message)).toEqual({
      errorClass: RUNTIME_ERROR_CLASS.PROVIDER_STREAM,
      errorReason: "provider_stream_error",
      retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
      requiredAction: "none",
      takesAgentOffline: false,
    });
});
