import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { agentMigrationRuntime } from "#src/features/agents/profile-panel/agent-profile-runtime";
import { readableRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";

const readable = {
  runtime: RUNTIME_PROVIDER.PI,
  modelProvider: "",
  model: "pi-default",
  reasoning: "",
};

test("a readable runtime config names the migration refusal's runtime and model", () => {
  expect(agentMigrationRuntime(readable)).toEqual({
    runtime: RUNTIME_PROVIDER.PI,
    model: "pi-default",
  });
});

test("an unreadable stored config leaves the migration section nothing to name", () => {
  const stored = { runtime: 42, provider: "not-an-object" };
  expect(agentMigrationRuntime(readableRuntimeConfig(stored, "agent-1"))).toBeUndefined();
});
