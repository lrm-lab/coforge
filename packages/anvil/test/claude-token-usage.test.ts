import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { ClaudeSessionObservations } from "#src/claude-code/observations";
import { ClaudeCodeAgentSession } from "#src/claude-code/session";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import type { JsonlProcess } from "#src/jsonl-process";
import { controlledClaude } from "./fixtures/claude-feed";
import { fixtureClaudeHost } from "./fixtures/claude-host";

function tokenEvents(events: readonly AgentRuntimeEvent[]) {
  return events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE);
}

test("ClaudeSessionObservations folds cumulative modelUsage across turns and carries prior totals forward on backward reset", () => {
  const observations = new ClaudeSessionObservations("claude-sonnet-4-6");

  const turn1 = [
    ...observations.read(
      {
        type: "result",
        timestamp: "2026-11-24T02:00:00.000Z",
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: 10_000,
          cache_creation_input_tokens: 500,
          output_tokens: 200,
        },
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 1_000,
            cacheReadInputTokens: 10_000,
            cacheCreationInputTokens: 500,
            outputTokens: 200,
            contextWindow: 200_000,
          },
          "claude-haiku-4-5": {
            inputTokens: 300,
            cacheReadInputTokens: 1_000,
            cacheCreationInputTokens: 0,
            outputTokens: 50,
            contextWindow: 200_000,
          },
        },
      },
      "sess-1",
    ),
  ];
  expect(tokenEvents(turn1)).toEqual([
    {
      type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
      usage: {
        uncachedInputTokens: 1_300,
        cacheReadTokens: 11_000,
        cacheWriteTokens: 500,
        outputTokens: 250,
        model: "claude-sonnet-4-6",
        occurredAt: "2026-11-24T02:00:00.000Z",
      },
    },
  ]);

  const turn2 = [
    ...observations.read(
      {
        type: "result",
        timestamp: "2026-11-24T02:01:00.000Z",
        usage: {
          input_tokens: 800,
          cache_read_input_tokens: 12_000,
          cache_creation_input_tokens: 100,
          output_tokens: 150,
        },
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 1_800,
            cacheReadInputTokens: 22_000,
            cacheCreationInputTokens: 600,
            outputTokens: 350,
            contextWindow: 200_000,
          },
          "claude-haiku-4-5": {
            inputTokens: 500,
            cacheReadInputTokens: 1_500,
            cacheCreationInputTokens: 0,
            outputTokens: 90,
            contextWindow: 200_000,
          },
        },
      },
      "sess-1",
    ),
  ];
  expect(tokenEvents(turn2)).toEqual([
    {
      type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
      usage: {
        uncachedInputTokens: 1_000,
        cacheReadTokens: 12_500,
        cacheWriteTokens: 100,
        outputTokens: 190,
        model: "claude-sonnet-4-6",
        occurredAt: "2026-11-24T02:01:00.000Z",
      },
    },
  ]);

  const turn3AfterReset = [
    ...observations.read(
      {
        type: "result",
        timestamp: "2026-11-24T02:02:00.000Z",
        usage: {
          input_tokens: 300,
          cache_read_input_tokens: 4_000,
          cache_creation_input_tokens: 200,
          output_tokens: 70,
        },
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 400,
            cacheReadInputTokens: 4_000,
            cacheCreationInputTokens: 200,
            outputTokens: 80,
            contextWindow: 200_000,
          },
        },
      },
      "sess-1",
    ),
  ];
  expect(tokenEvents(turn3AfterReset)).toEqual([
    {
      type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
      usage: {
        uncachedInputTokens: 400,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 200,
        outputTokens: 80,
        model: "claude-sonnet-4-6",
        occurredAt: "2026-11-24T02:02:00.000Z",
      },
    },
  ]);

  const turn4PostReset = [
    ...observations.read(
      {
        type: "result",
        timestamp: "2026-11-24T02:03:00.000Z",
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 650,
            cacheReadInputTokens: 9_000,
            cacheCreationInputTokens: 250,
            outputTokens: 180,
            contextWindow: 200_000,
          },
        },
      },
      "sess-1",
    ),
  ];
  expect(tokenEvents(turn4PostReset)).toEqual([
    {
      type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
      usage: {
        uncachedInputTokens: 250,
        cacheReadTokens: 5_000,
        cacheWriteTokens: 50,
        outputTokens: 100,
        model: "claude-sonnet-4-6",
        occurredAt: "2026-11-24T02:03:00.000Z",
      },
    },
  ]);
});

test("ClaudeCodeAgentSession emits TOKEN_USAGE and completed for failing, interrupting, and queued-idle result records", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  try {
    await session.sendMessage("first");
    await emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      usage: { input_tokens: 400, output_tokens: 60 },
    });
    const failedTokenIndex = events.findIndex(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const failedCompletedIndex = events.findIndex((event) => event.type === "completed");
    expect(failedTokenIndex).toBeGreaterThanOrEqual(0);
    expect(failedCompletedIndex).toBeGreaterThan(failedTokenIndex);
    expect(events[failedCompletedIndex]).toEqual({ type: "completed", status: "failed" });

    events.length = 0;
    await session.sendMessage("second");
    const queuedNotice = session.notify!("queued-turn");
    await emit(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      },
    );
    await queuedNotice;
    await emit({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 200, output_tokens: 30 },
    });
    events.length = 0;

    await emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      usage: { input_tokens: 350, output_tokens: 45 },
    });
    expect(events.filter((event) => event.type === "completed")).toEqual([
      { type: "completed", status: "failed" },
    ]);
    expect(tokenEvents(events)).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: expect.objectContaining({
          uncachedInputTokens: 350,
          outputTokens: 45,
        }),
      },
    ]);

    events.length = 0;
    await emit({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 90, output_tokens: 10 },
    });
    expect(tokenEvents(events)).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: expect.objectContaining({
          uncachedInputTokens: 90,
          outputTokens: 10,
        }),
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("ClaudeCodeAgentSession emits TOKEN_USAGE before completed when a turn settles while interrupting", async () => {
  const recordListeners = new Set<(record: Record<string, unknown>) => void>();
  const feed = (record: Record<string, unknown>) => {
    for (const listener of recordListeners) listener(record);
  };
  let interrupted = false;
  const fakeProcess = {
    pid: 1234,
    onRecord: (listener: (record: Record<string, unknown>) => void) => {
      recordListeners.add(listener);
      return () => recordListeners.delete(listener);
    },
    onFailure: () => () => {},
    onClose: () => () => {},
    onStderr: () => () => {},
    send: async () => {},
    interrupt: () => {
      interrupted = true;
    },
    dispose: async () => {},
    exitInfo: () => undefined,
    killTurnProcesses: async () => {},
  } as unknown as JsonlProcess;

  const session = new ClaudeCodeAgentSession(
    fixtureClaudeHost,
    fakeProcess,
    async () => {},
    undefined,
    undefined,
    undefined,
    "sess-interrupt",
  );
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  try {
    await session.sendMessage("work");
    feed({ type: "system", subtype: "init", session_id: "sess-interrupt" });
    const interrupting = session.interrupt();
    expect(interrupted).toBe(true);
    feed({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "sess-interrupt",
      usage: { input_tokens: 120, output_tokens: 15 },
    });
    await interrupting;
    const tokenIndex = events.findIndex(
      (event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    );
    const completedIndex = events.findIndex((event) => event.type === "completed");
    expect(tokenIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(tokenIndex);
    expect(events[tokenIndex]).toEqual({
      type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
      usage: expect.objectContaining({
        uncachedInputTokens: 120,
        outputTokens: 15,
      }),
    });
    expect(events[completedIndex]).toEqual({ type: "completed", status: "interrupted" });
  } finally {
    await session.dispose();
  }
});
