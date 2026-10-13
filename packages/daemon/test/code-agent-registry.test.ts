import { expect, test } from "bun:test";

import { RUNTIME_PROVIDER, RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN } from "@lrm/coforge-sdk/internal";
import { createCodeAgentProvider } from "#src/code-agent/registry";

test("code-agent registry exposes every supported Provider", () => {
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.COFORGE).provider).toBe(RUNTIME_PROVIDER.COFORGE);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.PI).provider).toBe(RUNTIME_PROVIDER.PI);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.CODEX).provider).toBe(RUNTIME_PROVIDER.CODEX);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.CLAUDE_CODE).provider).toBe(
    RUNTIME_PROVIDER.CLAUDE_CODE,
  );
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.KIRO).provider).toBe(RUNTIME_PROVIDER.KIRO);
  expect(createCodeAgentProvider(RUNTIME_PROVIDER.CURSOR).provider).toBe(RUNTIME_PROVIDER.CURSOR);
});

test("advertised usage scanning matches each registered provider's reader", () => {
  for (const provider of Object.values(RUNTIME_PROVIDER)) {
    const runtime = createCodeAgentProvider(provider);
    expect(RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[provider]).toBe(
      typeof runtime.readUsage === "function",
    );
  }
});
