import { expect, test } from "bun:test";

import {
  parseAgentRuntimeConfig,
  runtimeStartFields,
} from "#src/server/agents/agent-runtime-config.server";

const LEGACY_SUFFIXED_MODELS = [
  ["gemini-3.8-flash-high", "gemini-3.8-flash", "high"],
  ["gemini-3.8-flash-medium", "gemini-3.8-flash", "medium"],
  ["gemini-3.8-flash-low", "gemini-3.8-flash", "low"],
  ["gemini-3.7-flash-high", "gemini-3.7-flash", "high"],
  ["gemini-3.7-flash-medium", "gemini-3.7-flash", "medium"],
  ["gemini-3.7-flash-low", "gemini-3.7-flash", "low"],
  ["gemini-3.6-flash-high", "gemini-3.6-flash", "high"],
  ["gemini-3.6-flash-medium", "gemini-3.6-flash", "medium"],
  ["gemini-3.6-flash-low", "gemini-3.6-flash", "low"],
  ["gemini-3.1-pro-high", "gemini-3.1-pro", "high"],
  ["gemini-3.1-pro-low", "gemini-3.1-pro", "low"],
] as const;

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

for (const [legacy, model, reasoning] of LEGACY_SUFFIXED_MODELS) {
  test(`a row stored with ${legacy} reads as ${model} at ${reasoning}`, () => {
    expect(parseAgentRuntimeConfig(storedConfig({ model: legacy }))).toMatchObject({
      model,
      reasoning,
    });
  });
}

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
