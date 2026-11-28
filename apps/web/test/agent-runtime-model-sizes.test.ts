import { expect, test } from "bun:test";
import { sizesFromForm } from "#src/features/agents/agent-form";
import { modelSizesApply } from "#src/features/agents/agent-model-sizes";
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

test("only Pi on the Computer's own providers or OpenRouter reads the sizes (task #124)", () => {
  expect(modelSizesApply("pi", "")).toBe(true);
  expect(modelSizesApply("pi", "openrouter")).toBe(true);
  expect(modelSizesApply("pi", "deepseek")).toBe(false);
  expect(modelSizesApply("claude-code", "")).toBe(false);
  expect(modelSizesApply("claude-code", "openrouter")).toBe(false);
  expect(modelSizesApply("codex", "")).toBe(false);
  expect(modelSizesApply("codex", "openrouter")).toBe(false);
  expect(modelSizesApply("coforge", "")).toBe(false);
  expect(modelSizesApply("opencode", "")).toBe(false);
});

test("sizes for a runtime that does not read them are neither kept nor sent (task #124)", () => {
  const sizes = { contextWindow: 200_000, maxOutputTokens: 64_000 };
  const claude = { ...selection, provider: "claude-code" as const, ...sizes };
  const stored = agentRuntimeConfig(claude, { kind: "default" });
  expect("contextWindow" in stored).toBe(false);
  expect("maxOutputTokens" in stored).toBe(false);
  // A pair saved before the rule reads back without an error and is not sent.
  const old = parseAgentRuntimeConfig({ ...stored, ...sizes });
  const start = runtimeStartFields(old);
  expect("contextWindow" in start).toBe(false);
  expect("maxOutputTokens" in start).toBe(false);
  // Pi on a built-in provider other than OpenRouter does not read them either.
  const deepseek = agentRuntimeConfig(
    { ...selection, modelProvider: "deepseek", ...sizes },
    { kind: "coforge", providerId: "deepseek" },
  );
  expect("contextWindow" in deepseek).toBe(false);
  const openrouter = agentRuntimeConfig(
    { ...selection, modelProvider: "openrouter", ...sizes },
    { kind: "coforge", providerId: "openrouter" },
  );
  expect(runtimeStartFields(openrouter)).toMatchObject(sizes);
});

test("sizesFromForm reads whole-number sizes for create/update and omits hidden or blank fields", () => {
  const filled = new FormData();
  filled.set("contextWindow", "200000");
  filled.set("maxOutputTokens", "64000");
  expect(sizesFromForm(filled)).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000 });
  expect(sizesFromForm(new FormData())).toEqual({});
});
