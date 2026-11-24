import { expect, test } from "bun:test";
import { encodeAgentTokenUsage, type AgentTokenUsage } from "@lrm/coforge-sdk/internal";
import { createAgentTokenUsageMethod } from "#src/server/centrifugo/agent-token-usage-receiver.server";
import type { AgentTokenUsageTurnInput } from "#src/server/db/repositories/agent-token-usage.repositories.server";

function sample(overrides: Partial<AgentTokenUsage> = {}): AgentTokenUsage {
  return {
    protocolMajor: 1,
    requestId: "req-1",
    workspaceId: "w-1",
    computerId: "c-1",
    agentId: "a-1",
    provider: "codex",
    launchId: "launch-1",
    sessionId: "sess-1",
    turnSeq: 1,
    model: "gpt-5.4",
    uncachedInputTokens: 12_000,
    cacheReadTokens: 80_000,
    cacheWriteTokens: 0,
    outputTokens: 1_500,
    reasoningOutputTokens: 300,
    contextUsedTokens: 48_000,
    contextWindowTokens: 200_000,
    observedAtMs: Date.parse("2026-11-24T02:00:00.000Z"),
    daemonInstanceId: "d-1",
    clientSeq: 2,
    ...overrides,
  };
}

const daemonPrincipal = {
  kind: "daemon" as const,
  userId: "u-1",
  workspaceId: "w-1",
  computerId: "c-1",
};

test("persists valid token usage for the active launch and clamps future timestamps", async () => {
  const recorded: AgentTokenUsageTurnInput[] = [];
  const nowMs = Date.parse("2026-11-24T02:00:00.000Z");
  const method = createAgentTokenUsageMethod(
    {
      get: async () =>
        ({
          id: "a-1",
          workspaceId: "w-1",
          computerId: "c-1",
          runtimeConfig: { runtime: "codex" },
          state: { launchId: "launch-1" },
        }) as never,
    },
    {
      recordTurn: async (input) => {
        recorded.push(input);
      },
    },
    () => nowMs,
  );

  const farFuture = nowMs + 60 * 60 * 1000;
  const answer = await method(encodeAgentTokenUsage(sample({ observedAtMs: farFuture })), {
    principal: daemonPrincipal,
  });
  expect(answer).toBeInstanceOf(Uint8Array);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    workspaceId: "w-1",
    agentId: "a-1",
    launchId: "launch-1",
    turnSeq: 1,
    model: "gpt-5.4",
    uncachedInputTokens: 12_000,
    cacheReadTokens: 80_000,
    outputTokens: 1_500,
    reasoningOutputTokens: 300,
    contextUsedTokens: 48_000,
    contextWindowTokens: 200_000,
  });
  expect(recorded[0]?.recordedAt.getTime()).toBe(nowMs + 5 * 60 * 1000);
});

test("rejects foreign scope with 403 and ignores stale launches silently", async () => {
  const recorded: AgentTokenUsageTurnInput[] = [];
  const method = createAgentTokenUsageMethod(
    {
      get: async () =>
        ({
          id: "a-1",
          workspaceId: "w-1",
          computerId: "c-1",
          runtimeConfig: { runtime: "codex" },
          state: { launchId: "launch-current" },
        }) as never,
    },
    {
      recordTurn: async (input) => {
        recorded.push(input);
      },
    },
  );

  const foreign = await method(encodeAgentTokenUsage(sample({ workspaceId: "w-other" })), {
    principal: daemonPrincipal,
  });
  expect(foreign).toEqual({ code: 403, message: "Agent token usage scope is not authorized" });

  const stale = await method(encodeAgentTokenUsage(sample({ launchId: "launch-old" })), {
    principal: daemonPrincipal,
  });
  expect(stale).toBeInstanceOf(Uint8Array);
  expect(recorded).toHaveLength(0);

  const failing = createAgentTokenUsageMethod(
    {
      get: async () =>
        ({
          id: "a-1",
          workspaceId: "w-1",
          computerId: "c-1",
          runtimeConfig: { runtime: "codex" },
          state: { launchId: "launch-1" },
        }) as never,
    },
    {
      recordTurn: async () => {
        throw new Error("db unavailable");
      },
    },
  );
  const failed = await failing(encodeAgentTokenUsage(sample()), {
    principal: daemonPrincipal,
  });
  expect(failed).toEqual({ code: 500, message: "Agent token usage could not be recorded" });
});
