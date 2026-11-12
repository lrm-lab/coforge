import { expect, test } from "bun:test";
import {
  agentRuntimeConfig,
  parseAgentRuntimeConfig,
  runtimeStartFields,
} from "#src/server/agents/agent-runtime-config.server";

const selection = {
  provider: "pi" as const,
  model: "claude-sonnet-4-6",
  modelProvider: "anthropic",
  reasoning: "high",
};

test("a stored config keeps the sizes a person filled in, and says nothing when they filled none", () => {
  const sized = agentRuntimeConfig(
    { ...selection, contextWindow: 200_000, maxOutputTokens: 64_000 },
    { kind: "default" },
  );
  expect(parseAgentRuntimeConfig(sized)).toMatchObject({
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  });
  const bare = agentRuntimeConfig(selection, { kind: "default" });
  expect("contextWindow" in bare).toBe(false);
  expect("maxOutputTokens" in bare).toBe(false);
});

test("a stored size that is not a size is unreadable, rather than silently dropped", () => {
  const sized = agentRuntimeConfig({ ...selection, contextWindow: 200_000 }, { kind: "default" });
  expect(() => parseAgentRuntimeConfig({ ...sized, contextWindow: 0 })).toThrow();
  expect(() => parseAgentRuntimeConfig({ ...sized, maxOutputTokens: "many" })).toThrow();
});

test("a Start and a config push carry the sizes, and leave them out when there are none", () => {
  const sized = agentRuntimeConfig(
    { ...selection, contextWindow: 200_000, maxOutputTokens: 64_000 },
    { kind: "default" },
  );
  expect(runtimeStartFields(sized, 7)).toMatchObject({
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  });
  const bare = runtimeStartFields(agentRuntimeConfig(selection, { kind: "default" }));
  expect("contextWindow" in bare).toBe(false);
  expect("maxOutputTokens" in bare).toBe(false);
});
