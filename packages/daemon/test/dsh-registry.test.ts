import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import { externalCodeAgents } from "#src/code-agent/runtime-executable";

test("DSH has a factory and is probed like any external CLI", () => {
  const provider = createCodeAgentProvider(RUNTIME_PROVIDER.DSH);
  expect(provider.provider).toBe(RUNTIME_PROVIDER.DSH);
  expect(provider.readUsage).toBeUndefined();
  expect(
    externalCodeAgents.some((runtime) => String(runtime.provider) === RUNTIME_PROVIDER.DSH),
  ).toBe(true);
});
