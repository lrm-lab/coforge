import { expect, test } from "bun:test";
import { runtimeConfigOf, runtimeFieldsOf } from "#src/daemon-runtime/runtime-launch-intent";

const start = {
  protocolMajor: 1 as const,
  requestId: "start-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
};

const intent = {
  provider: "pi" as const,
  model: "claude-sonnet-4-6",
  modelProvider: "anthropic",
  reasoning: "high",
};

test("a Start carries the form's sizes only when a person filled them in", () => {
  expect(
    runtimeConfigOf({ ...start, ...intent, contextWindow: 200_000, maxOutputTokens: 64_000 }),
  ).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 64_000 });
  // Absent, not zero: the daemon then follows the runtime's own model entry (task #30).
  const bare = runtimeConfigOf({ ...start, ...intent });
  expect("contextWindow" in bare).toBe(false);
  expect("maxOutputTokens" in bare).toBe(false);
});

test("a config push replaces the sizes it carries and only those", () => {
  expect(runtimeFieldsOf({ ...intent, contextWindow: 120_000 })).toMatchObject({
    contextWindow: 120_000,
  });
  const empty = runtimeFieldsOf(intent);
  expect("contextWindow" in empty).toBe(false);
  expect("maxOutputTokens" in empty).toBe(false);
});
