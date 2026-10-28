import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { createAgentInputSchema, updateAgentInputSchema } from "#src/features/agents/agent.schemas";
import { runtimeProviderSelectionRefusal } from "#src/features/agents/runtime-provider-selection";

const agentId = "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da";

test("DeepSeek Harness is admitted like any known runtime", () => {
  expect(runtimeProviderSelectionRefusal(RUNTIME_PROVIDER.DSH)).toBeUndefined();
  const input = {
    name: "builder",
    description: "",
    provider: RUNTIME_PROVIDER.DSH,
    computerId: "computer",
    agentId,
  };
  expect(createAgentInputSchema.safeParse(input).success).toBe(true);
  expect(updateAgentInputSchema.safeParse(input).success).toBe(true);
});

test("an unknown runtime is still refused", () => {
  expect(runtimeProviderSelectionRefusal("not-a-runtime")).toBe("agent-provider-unsupported");
});
