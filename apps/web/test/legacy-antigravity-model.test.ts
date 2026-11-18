import { expect, test } from "bun:test";

import {
  LEGACY_ANTIGRAVITY_EFFORT_MODELS,
  parseAgentRuntimeConfig,
  runtimeStartFields,
} from "#src/server/agents/agent-runtime-config.server";

function storedConfig(overrides: Record<string, unknown> = {}) {
  return {
    runtime: "antigravity",
    provider: { kind: "default" },
    model: "gemini-3.8-flash",
    modelProvider: "",
    reasoning: "",
    ...overrides,
  };
}

for (const [legacy, split] of Object.entries(LEGACY_ANTIGRAVITY_EFFORT_MODELS)) {
  test(`a row stored with ${legacy} reads as ${split.model} at ${split.reasoning}`, () => {
    expect(parseAgentRuntimeConfig(storedConfig({ model: legacy }))).toMatchObject(split);
  });
}

test("a model named like an Object prototype key is not a legacy id", () => {
  for (const model of ["toString", "constructor", "valueOf", "__proto__"]) {
    expect(parseAgentRuntimeConfig(storedConfig({ model }))).toMatchObject({
      model,
      reasoning: "",
    });
  }
});

test("the launch fields carry the split model, never the suffixed id", () => {
  const config = parseAgentRuntimeConfig(storedConfig({ model: "gemini-3.1-pro-high" }));
  expect(runtimeStartFields(config)).toMatchObject({
    provider: "antigravity",
    model: "gemini-3.1-pro",
    reasoning: "high",
  });
});

test("a suffixed id that is a real catalog model stays as it is", () => {
  const config = parseAgentRuntimeConfig(storedConfig({ model: "gpt-oss-120b-medium" }));
  expect(config).toMatchObject({ model: "gpt-oss-120b-medium", reasoning: "" });
});

test("a model with an unrelated suffix stays as it is", () => {
  const config = parseAgentRuntimeConfig(storedConfig({ model: "claude-opus-4-6-thinking" }));
  expect(config).toMatchObject({ model: "claude-opus-4-6-thinking", reasoning: "" });
});

test("a legacy id with a reasoning the user picked is left alone", () => {
  const config = parseAgentRuntimeConfig(
    storedConfig({ model: "gemini-3.8-flash-high", reasoning: "low" }),
  );
  expect(config).toMatchObject({ model: "gemini-3.8-flash-high", reasoning: "low" });
});

test("a legacy antigravity id stored under another runtime is left alone", () => {
  const config = parseAgentRuntimeConfig(
    storedConfig({ runtime: "claude-code", model: "gemini-3.8-flash-high" }),
  );
  expect(config).toMatchObject({ model: "gemini-3.8-flash-high", reasoning: "" });
});
