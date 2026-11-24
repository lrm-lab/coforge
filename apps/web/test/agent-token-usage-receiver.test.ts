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

test("persists valid token usage across changed launches, stopped/archived agents, and provider changes while clamping future timestamps", async () => {
  const recorded: AgentTokenUsageTurnInput[] = [];
  const nowMs = Date.parse("2026-11-24T02:00:00.000Z");
  const agentsById = new Map<string, Record<string, unknown>>([
    [
      "a-1",
      {
        id: "a-1",
        workspaceId: "w-1",
        computerId: "c-1",
        runtimeConfig: { runtime: "codex" },
        state: { launchId: "launch-current" },
      },
    ],
    [
      "a-stopped",
      {
        id: "a-stopped",
        workspaceId: "w-1",
        computerId: "c-1",
        runtimeConfig: { runtime: "claude-code" },
        stoppedAt: new Date("2026-11-24T01:59:00.000Z"),
        state: null,
      },
    ],
    [
      "a-archived",
      {
        id: "a-archived",
        workspaceId: "w-1",
        computerId: "c-1",
        runtimeConfig: { runtime: "pi" },
        deletedAt: new Date("2026-11-24T01:59:30.000Z"),
        state: { launchId: "launch-next" },
      },
    ],
  ]);
  const method = createAgentTokenUsageMethod(
    {
      get: async (id) => agentsById.get(id) as never,
    },
    {
      recordTurn: async (input) => {
        recorded.push(input);
      },
    },
    () => nowMs,
  );

  const farFuture = nowMs + 60 * 60 * 1000;
  const answer = await method(
    encodeAgentTokenUsage(sample({ launchId: "launch-old", observedAtMs: farFuture })),
    { principal: daemonPrincipal },
  );
  expect(answer).toBeInstanceOf(Uint8Array);

  const stoppedAnswer = await method(
    encodeAgentTokenUsage(
      sample({
        agentId: "a-stopped",
        provider: "codex",
        launchId: "launch-shutdown",
        turnSeq: 4,
      }),
    ),
    { principal: daemonPrincipal },
  );
  expect(stoppedAnswer).toBeInstanceOf(Uint8Array);

  const archivedAnswer = await method(
    encodeAgentTokenUsage(
      sample({
        agentId: "a-archived",
        provider: "pi",
        launchId: "launch-final",
        turnSeq: 2,
      }),
    ),
    { principal: daemonPrincipal },
  );
  expect(archivedAnswer).toBeInstanceOf(Uint8Array);

  expect(recorded).toHaveLength(3);
  expect(recorded[0]).toMatchObject({
    workspaceId: "w-1",
    agentId: "a-1",
    launchId: "launch-old",
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
  expect(recorded[1]).toMatchObject({
    agentId: "a-stopped",
    provider: "codex",
    launchId: "launch-shutdown",
    turnSeq: 4,
  });
  expect(recorded[2]).toMatchObject({
    agentId: "a-archived",
    provider: "pi",
    launchId: "launch-final",
    turnSeq: 2,
  });
});

test("logs structured warnings on every rejected or dropped path with zero silent drops", async () => {
  const warnings: Record<string, unknown>[] = [];
  const originalWarn = console.warn;
  console.warn = (line?: unknown) => {
    if (typeof line === "string") warnings.push(JSON.parse(line) as Record<string, unknown>);
  };
  try {
    const recorded: AgentTokenUsageTurnInput[] = [];
    const agentsById = new Map<string, Record<string, unknown>>([
      [
        "a-1",
        {
          id: "a-1",
          workspaceId: "w-1",
          computerId: "c-1",
          runtimeConfig: { runtime: "codex" },
          state: { launchId: "launch-1" },
        },
      ],
      [
        "a-other-computer",
        {
          id: "a-other-computer",
          workspaceId: "w-1",
          computerId: "c-other",
          runtimeConfig: { runtime: "codex" },
          state: { launchId: "launch-1" },
        },
      ],
    ]);
    const method = createAgentTokenUsageMethod(
      {
        get: async (id) => agentsById.get(id) as never,
      },
      {
        recordTurn: async (input) => {
          recorded.push(input);
        },
      },
    );

    const malformed = await method(new Uint8Array([0xff, 0x00, 0x01]), {
      principal: daemonPrincipal,
    });
    expect(malformed).toEqual({ code: 400, message: "invalid Agent token usage" });

    const foreign = await method(encodeAgentTokenUsage(sample({ workspaceId: "w-other" })), {
      principal: daemonPrincipal,
    });
    expect(foreign).toEqual({ code: 403, message: "Agent token usage scope is not authorized" });

    const missing = await method(encodeAgentTokenUsage(sample({ agentId: "a-missing" })), {
      principal: daemonPrincipal,
    });
    expect(missing).toBeInstanceOf(Uint8Array);

    const mismatched = await method(
      encodeAgentTokenUsage(sample({ agentId: "a-other-computer" })),
      { principal: daemonPrincipal },
    );
    expect(mismatched).toBeInstanceOf(Uint8Array);

    const overflow = await method(encodeAgentTokenUsage(sample({ turnSeq: 2_147_483_648 })), {
      principal: daemonPrincipal,
    });
    expect(overflow).toBeInstanceOf(Uint8Array);

    expect(recorded).toHaveLength(0);
    expect(warnings.map((w) => [w.event, w.reason])).toEqual([
      ["agent_token_usage:rejected", "invalid_payload"],
      ["agent_token_usage:rejected", "scope_mismatch"],
      ["agent_token_usage:dropped", "agent_not_found"],
      ["agent_token_usage:dropped", "agent_scope_mismatch"],
      ["agent_token_usage:dropped", "turn_seq_overflow"],
    ]);

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
    expect(warnings.at(-1)).toMatchObject({
      event: "agent_token_usage:rejected",
      reason: "unexpected: Error",
    });
  } finally {
    console.warn = originalWarn;
  }
});
