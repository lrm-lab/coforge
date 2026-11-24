import { expect, test } from "bun:test";
import { AgentTokenUsageSchema } from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import { decodeAgentTokenUsage, encodeAgentTokenUsage, type AgentTokenUsage } from "./index";

function tokenUsage(): AgentTokenUsage {
  return {
    protocolMajor: 1,
    requestId: "req-1",
    workspaceId: "w-1",
    computerId: "c-1",
    agentId: "a-1",
    provider: "codex",
    launchId: "launch-1",
    sessionId: "session-1",
    turnSeq: 1,
    model: "gpt-5.4",
    uncachedInputTokens: 12_400,
    cacheReadTokens: 84_200,
    cacheWriteTokens: 0,
    outputTokens: 1_850,
    reasoningOutputTokens: 420,
    contextUsedTokens: 48_200,
    contextWindowTokens: 200_000,
    observedAtMs: 1_758_000_000_000,
    daemonInstanceId: "daemon-1",
    clientSeq: 5,
  };
}

test("token usage round-trips with and without optional fields", () => {
  const full = tokenUsage();
  expect(decodeAgentTokenUsage(encodeAgentTokenUsage(full))).toEqual(full);
  const minimal: AgentTokenUsage = {
    protocolMajor: 1,
    requestId: "req-2",
    workspaceId: "w-1",
    computerId: "c-1",
    agentId: "a-1",
    provider: "claude-code",
    launchId: "launch-1",
    sessionId: "session-1",
    turnSeq: 2,
    model: "",
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    observedAtMs: 1_758_000_000_000,
    daemonInstanceId: "daemon-1",
    clientSeq: 6,
  };
  expect(decodeAgentTokenUsage(encodeAgentTokenUsage(minimal))).toEqual(minimal);
});

test("token usage rejects invalid protocol, provider, scope, and numeric fields", () => {
  const message = tokenUsage();
  expect(() => encodeAgentTokenUsage({ ...message, protocolMajor: 2 })).toThrow(
    "invalid token usage protocol/provider",
  );
  expect(() => encodeAgentTokenUsage({ ...message, provider: "unknown" as "codex" })).toThrow(
    "invalid token usage protocol/provider",
  );
  expect(() => encodeAgentTokenUsage({ ...message, launchId: "" })).toThrow(
    "invalid token usage launchId",
  );
  expect(() => encodeAgentTokenUsage({ ...message, turnSeq: 0 })).toThrow(
    "invalid token usage turnSeq",
  );
  expect(() => encodeAgentTokenUsage({ ...message, uncachedInputTokens: -1 })).toThrow(
    "invalid token usage uncachedInputTokens",
  );
  expect(() => encodeAgentTokenUsage({ ...message, contextWindowTokens: 0 })).toThrow(
    "invalid token usage contextWindowTokens",
  );
});

test("token usage keeps wire tags stable and contiguous", () => {
  const fields = Object.fromEntries(
    AgentTokenUsageSchema.fields.map((field) => [field.localName, field.number]),
  );
  expect(fields).toMatchObject({
    protocolMajor: 1,
    requestId: 2,
    workspaceId: 3,
    computerId: 4,
    agentId: 5,
    provider: 6,
    launchId: 7,
    sessionId: 8,
    turnSeq: 9,
    model: 10,
    uncachedInputTokens: 11,
    cacheReadTokens: 12,
    cacheWriteTokens: 13,
    outputTokens: 14,
    reasoningOutputTokens: 15,
    contextUsedTokens: 16,
    contextWindowTokens: 17,
    observedAtMs: 18,
    daemonInstanceId: 19,
    clientSeq: 20,
  });
});
