import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { CodexAgentSession } from "#src/codex/session";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import type { JsonlProcess } from "#src/jsonl-process";

function createTestCodexSession(threadId = "thread-main", model = "gpt-5.4") {
  const recordListeners = new Set<(record: Record<string, unknown>) => void>();
  let nextTurn = 0;
  const fakeProcess = {
    pid: 4321,
    onRecord: (listener: (record: Record<string, unknown>) => void) => {
      recordListeners.add(listener);
      return () => recordListeners.delete(listener);
    },
    onStderr: () => () => {},
    onFailure: () => () => {},
    onClose: () => () => {},
    request: async (payload: { method?: string }) => {
      if (payload.method === "turn/start")
        return { result: { turn: { id: `turn-${++nextTurn}` } } };
      return { result: {} };
    },
    dispose: async () => {},
    killTurnProcesses: async () => {},
  } as unknown as JsonlProcess;

  const session = new CodexAgentSession(
    fakeProcess,
    threadId,
    false,
    "agent-1",
    "runtime-1",
    undefined,
    undefined,
    model,
  );
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  const feed = (record: Record<string, unknown>) => {
    for (const listener of recordListeners) listener(record);
  };
  return { session, events, feed };
}

test("CodexAgentSession captures late main-thread thread/tokenUsage/updated after turn/completed without emitting idle context-usage", async () => {
  const { session, events, feed } = createTestCodexSession();
  try {
    await session.sendMessage("hello");
    feed({ method: "turn/started", params: { threadId: "thread-main", turn: { id: "turn-1" } } });
    feed({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-main", turnId: "turn-1", itemId: "m1", delta: "hi" },
    });
    feed({
      method: "turn/completed",
      params: { threadId: "thread-main", turn: { id: "turn-1", status: "completed" } },
    });

    feed({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-main",
        turnId: "turn-1",
        tokenUsage: {
          modelContextWindow: 200_000,
          last: {
            inputTokens: 2_000,
            cachedInputTokens: 1_500,
            outputTokens: 300,
            reasoningOutputTokens: 80,
            totalTokens: 2_300,
          },
          total: {
            inputTokens: 2_000,
            cachedInputTokens: 1_500,
            outputTokens: 300,
            reasoningOutputTokens: 80,
            totalTokens: 2_300,
          },
        },
      },
    });

    expect(events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE)).toEqual(
      [],
    );
    expect(events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE)).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 500,
          cacheReadTokens: 1_500,
          cacheWriteTokens: 0,
          outputTokens: 300,
          reasoningOutputTokens: 80,
          model: "gpt-5.4",
          contextUsedTokens: 2_300,
          contextWindowTokens: 200_000,
        },
      },
    ]);

    feed({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-main",
        turnId: "turn-1",
        tokenUsage: {
          modelContextWindow: 200_000,
          last: {
            inputTokens: 2_000,
            cachedInputTokens: 1_500,
            outputTokens: 300,
            reasoningOutputTokens: 80,
            totalTokens: 2_300,
          },
          total: {
            inputTokens: 2_000,
            cachedInputTokens: 1_500,
            outputTokens: 300,
            reasoningOutputTokens: 80,
            totalTokens: 2_300,
          },
        },
      },
    });
    expect(
      events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE),
    ).toHaveLength(1);
  } finally {
    await session.dispose();
  }
});

test("CodexAgentSession captures secondary/subagent thread token usage independently of main thread baseline and without emitting context-usage", async () => {
  const { session, events, feed } = createTestCodexSession();
  try {
    await session.sendMessage("delegate");
    feed({ method: "turn/started", params: { threadId: "thread-main", turn: { id: "turn-1" } } });
    feed({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-main",
        turnId: "turn-1",
        tokenUsage: {
          modelContextWindow: 200_000,
          last: {
            inputTokens: 1_000,
            cachedInputTokens: 600,
            outputTokens: 200,
            totalTokens: 1_200,
          },
          total: {
            inputTokens: 1_000,
            cachedInputTokens: 600,
            outputTokens: 200,
            totalTokens: 1_200,
          },
        },
      },
    });
    feed({
      method: "item/completed",
      params: {
        threadId: "thread-main",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "call-1",
          tool: "spawnAgent",
          receiverThreadIds: ["thread-sub-1"],
          agentsStates: { "thread-sub-1": { status: "running" } },
        },
      },
    });
    feed({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-sub-1",
        turnId: "sub-turn-1",
        tokenUsage: {
          modelContextWindow: 128_000,
          last: { inputTokens: 500, cachedInputTokens: 200, outputTokens: 150, totalTokens: 650 },
          total: { inputTokens: 500, cachedInputTokens: 200, outputTokens: 150, totalTokens: 650 },
        },
      },
    });
    feed({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-sub-1",
        turnId: "sub-turn-1",
        tokenUsage: {
          modelContextWindow: 128_000,
          last: { inputTokens: 400, cachedInputTokens: 300, outputTokens: 100, totalTokens: 500 },
          total: {
            inputTokens: 900,
            cachedInputTokens: 500,
            outputTokens: 250,
            totalTokens: 1_150,
          },
        },
      },
    });
    feed({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-main",
        turnId: "turn-1",
        tokenUsage: {
          modelContextWindow: 200_000,
          last: { inputTokens: 600, cachedInputTokens: 400, outputTokens: 100, totalTokens: 700 },
          total: {
            inputTokens: 1_600,
            cachedInputTokens: 1_000,
            outputTokens: 300,
            totalTokens: 1_900,
          },
        },
      },
    });

    expect(events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE)).toEqual(
      [
        { type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE, usedTokens: 1_200, windowTokens: 200_000 },
        { type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE, usedTokens: 700, windowTokens: 200_000 },
      ],
    );
    expect(events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE)).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 400,
          cacheReadTokens: 600,
          cacheWriteTokens: 0,
          outputTokens: 200,
          model: "gpt-5.4",
          contextUsedTokens: 1_200,
          contextWindowTokens: 200_000,
        },
      },
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 300,
          cacheReadTokens: 200,
          cacheWriteTokens: 0,
          outputTokens: 150,
          model: "gpt-5.4",
        },
      },
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 100,
          cacheReadTokens: 300,
          cacheWriteTokens: 0,
          outputTokens: 100,
          model: "gpt-5.4",
        },
      },
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 200,
          cacheReadTokens: 400,
          cacheWriteTokens: 0,
          outputTokens: 100,
          model: "gpt-5.4",
          contextUsedTokens: 700,
          contextWindowTokens: 200_000,
        },
      },
    ]);
  } finally {
    await session.dispose();
  }
});
