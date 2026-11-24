import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { CodexAgentSession } from "#src/codex/session";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import type { JsonlProcess } from "#src/jsonl-process";

function createTestCodexSession(threadId = "thread-main", model = "gpt-5.4", resumed = false) {
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
    resumed,
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

const usageTotals = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: 0,
});

const history = { inputTokens: 502_000, cachedInputTokens: 480_000, outputTokens: 12_500 };
const firstRequest = { inputTokens: 2_000, cachedInputTokens: 1_600, outputTokens: 500 };
const nextTotal = { inputTokens: 505_000, cachedInputTokens: 482_400, outputTokens: 13_100 };
const firstUsage = { uncachedInputTokens: 400, cacheReadTokens: 1_600, outputTokens: 500 };
const nextUsage = { uncachedInputTokens: 600, cacheReadTokens: 2_400, outputTokens: 600 };

function resumedUsageSession(resumed = true) {
  const { session, events, feed } = createTestCodexSession("thread-main", "gpt-5.4", resumed);
  return {
    session,
    start: async (turnId: string, beforeReply?: () => void) => {
      const starting = session.sendMessage("hello");
      beforeReply?.();
      await starting;
      feed({ method: "turn/started", params: { threadId: "thread-main", turn: { id: turnId } } });
    },
    finish: (turnId: string) =>
      feed({
        method: "turn/completed",
        params: { threadId: "thread-main", turn: { id: turnId, status: "completed" } },
      }),
    usage: (turnId: string | undefined, tokenUsage: Record<string, unknown>) =>
      feed({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-main", turnId, tokenUsage },
      }),
    counts: () =>
      events.flatMap((event) =>
        event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE
          ? [
              {
                uncachedInputTokens: event.usage.uncachedInputTokens,
                cacheReadTokens: event.usage.cacheReadTokens,
                outputTokens: event.usage.outputTokens,
              },
            ]
          : [],
      ),
  };
}

test("resumed Codex thread uses a pre-turn baseline only for subsequent increments", async () => {
  const replay = resumedUsageSession();
  try {
    replay.usage("prior-turn", { total: history, last: firstRequest });
    expect(replay.counts()).toEqual([]);
    await replay.start("turn-1");
    replay.usage("prior-turn", { total: history, last: firstRequest });
    replay.usage("turn-1", { total: nextTotal });
    replay.usage("turn-1", { total: nextTotal });
    replay.finish("turn-1");
    expect(replay.counts()).toEqual([nextUsage]);
  } finally {
    await replay.session.dispose();
  }
});

test("resumed Codex turn started without a baseline never uses cumulative usage for that turn", async () => {
  const replay = resumedUsageSession();
  try {
    await replay.start("turn-1");
    replay.usage("prior-turn", { total: history, last: firstRequest });
    replay.usage(undefined, { last: firstRequest });
    replay.usage("turn-1", { total: history });
    replay.usage("turn-1", { total: nextTotal });
    expect(replay.counts()).toEqual([]);
    replay.finish("turn-1");
    await replay.start("turn-2");
    replay.usage("turn-1", { total: history, last: firstRequest });
    replay.usage("turn-2", {
      total: { inputTokens: 508_000, cachedInputTokens: 484_800, outputTokens: 13_700 },
    });
    replay.finish("turn-2");
    expect(replay.counts()).toEqual([nextUsage]);
  } finally {
    await replay.session.dispose();
  }
});

test("resumed Codex accepts a late current-turn last once without a trusted baseline", async () => {
  const replay = resumedUsageSession();
  try {
    await replay.start("turn-1");
    replay.finish("turn-1");
    replay.usage("turn-1", { total: history, last: firstRequest });
    replay.usage("turn-1", { total: history, last: firstRequest });
    expect(replay.counts()).toEqual([firstUsage]);
  } finally {
    await replay.session.dispose();
  }
});

test("resumed Codex never uses a reset total as the current turn's delta", async () => {
  const replay = resumedUsageSession();
  try {
    replay.usage("prior-turn", { total: history });
    await replay.start("turn-1");
    replay.usage("turn-1", { total: firstRequest });
    replay.usage("turn-1", { total: nextTotal });
    expect(replay.counts()).toEqual([]);
  } finally {
    await replay.session.dispose();
  }
});

test("resumed Codex does not rebase on a reordered duplicate from the current turn", async () => {
  const replay = resumedUsageSession();
  try {
    replay.usage("prior-turn", { total: history });
    await replay.start("turn-1");
    replay.usage("turn-1", { total: nextTotal });
    const more = { inputTokens: 508_000, cachedInputTokens: 484_800, outputTokens: 13_700 };
    replay.usage("turn-1", { total: more });
    replay.usage("turn-1", { total: nextTotal });
    replay.usage("turn-1", {
      total: { inputTokens: 511_000, cachedInputTokens: 487_200, outputTokens: 14_300 },
    });
    replay.finish("turn-1");
    expect(replay.counts()).toEqual([nextUsage, nextUsage, nextUsage]);
  } finally {
    await replay.session.dispose();
  }
});

test("a partial pre-turn reading is not a cumulative baseline for resumed Codex", async () => {
  const replay = resumedUsageSession();
  try {
    replay.usage("prior-turn", { total: { inputTokens: history.inputTokens } });
    await replay.start("turn-1");
    replay.usage("turn-1", { total: nextTotal });
    expect(replay.counts()).toEqual([]);
  } finally {
    await replay.session.dispose();
  }
});

test("a matched last can supply usage after a resumed turn's cumulative-only frame was withheld", async () => {
  const replay = resumedUsageSession();
  try {
    await replay.start("turn-1");
    replay.usage("turn-1", { total: history });
    expect(replay.counts()).toEqual([]);
    replay.usage("turn-1", { total: history, last: firstRequest });
    replay.usage("turn-1", { total: history, last: firstRequest });
    expect(replay.counts()).toEqual([firstUsage]);
  } finally {
    await replay.session.dispose();
  }
});

const crossTurnUsage = { uncachedInputTokens: 100, cacheReadTokens: 0, outputTokens: 10 };

test.each([
  ["starting", false],
  ["started", false],
  ["started", true],
  ["after-current", false],
  ["after-current", true],
] as const)(
  "resumed Codex excludes advancing previous-turn totals (%s, last=%s)",
  async (order, withLast) => {
    const replay = resumedUsageSession();
    try {
      replay.usage("history", { total: usageTotals(1000, 100) });
      await replay.start("turn-1");
      replay.usage("turn-1", { total: usageTotals(1100, 110) });
      replay.finish("turn-1");
      const late = () => replay.usage("turn-1", { total: usageTotals(1150, 115) });
      await replay.start("turn-2", order === "starting" ? late : undefined);
      if (order === "started") late();
      replay.usage("turn-2", {
        total: usageTotals(1250, 125),
        ...(withLast ? { last: usageTotals(100, 10) } : {}),
      });
      expect(replay.counts()).toEqual(
        withLast ? [crossTurnUsage, crossTurnUsage] : [crossTurnUsage],
      );
      if (order === "after-current") late();
      replay.finish("turn-2");
      await replay.start("turn-3");
      replay.usage("turn-3", { total: usageTotals(1350, 135) });
      replay.finish("turn-3");
      const expected = withLast
        ? [crossTurnUsage, crossTurnUsage, crossTurnUsage]
        : [crossTurnUsage, crossTurnUsage];
      expect(replay.counts()).toEqual(expected);
    } finally {
      await replay.session.dispose();
    }
  },
);

test("resumed Codex fills a reordered last once and keeps the latest cumulative baseline", async () => {
  const replay = resumedUsageSession();
  try {
    await replay.start("turn-1");
    replay.usage("turn-1", { total: usageTotals(1_100, 110) });
    replay.usage("turn-1", { total: usageTotals(1_250, 125), last: usageTotals(150, 15) });
    replay.usage("turn-1", { total: usageTotals(1_100, 110), last: usageTotals(100, 10) });
    replay.usage("turn-1", { total: usageTotals(1_100, 110), last: usageTotals(100, 10) });
    replay.finish("turn-1");
    await replay.start("turn-2");
    replay.usage("turn-2", { total: usageTotals(1_450, 145) });
    replay.finish("turn-2");
    expect(replay.counts()).toEqual([
      { uncachedInputTokens: 150, cacheReadTokens: 0, outputTokens: 15 },
      { uncachedInputTokens: 100, cacheReadTokens: 0, outputTokens: 10 },
      { uncachedInputTokens: 200, cacheReadTokens: 0, outputTokens: 20 },
    ]);
  } finally {
    await replay.session.dispose();
  }
});

test.each([
  ["late", false],
  ["late", true],
  ["reordered", false],
  ["reordered", true],
] as const)(
  "resumed Codex fences the historical baseline (%s, last=%s)",
  async (order, withLast) => {
    const replay = resumedUsageSession();
    try {
      if (order === "reordered") replay.usage("prior", { total: usageTotals(1050, 105) });
      replay.usage("prior", { total: usageTotals(1000, 100) });
      await replay.start("turn-1");
      if (order === "late") replay.usage("prior", { total: usageTotals(1050, 105) });
      replay.usage("turn-1", {
        total: usageTotals(1150, 115),
        ...(withLast ? { last: usageTotals(100, 10) } : {}),
      });
      replay.finish("turn-1");
      expect(replay.counts()).toEqual(order === "reordered" || withLast ? [crossTurnUsage] : []);
    } finally {
      await replay.session.dispose();
    }
  },
);

test.each([false, true])(
  "resumed Codex only counts a trusted cumulative frame once (last=%s)",
  async (withLast) => {
    const replay = resumedUsageSession();
    try {
      replay.usage("prior", { total: history });
      await replay.start("turn-1");
      replay.usage("turn-1", { total: nextTotal });
      replay.usage("turn-1", { total: nextTotal });
      expect(replay.counts()).toEqual([]);
      if (withLast) {
        const last = { inputTokens: 3_000, cachedInputTokens: 2_400, outputTokens: 600 };
        replay.usage("turn-1", { total: nextTotal, last });
        replay.usage("turn-1", { total: nextTotal, last });
        expect(replay.counts()).toEqual([nextUsage]);
      }
      replay.finish("turn-1");
      expect(replay.counts()).toEqual([nextUsage]);
    } finally {
      await replay.session.dispose();
    }
  },
);

test.each([
  [64, "last"],
  [65, "last"],
  [64, "plain"],
  [65, "plain"],
  [64, "replay"],
  [65, "replay"],
] as const)(
  "resumed Codex keeps accurate usage after %d cumulative frames (%s)",
  async (frames, mode) => {
    const withLast = mode === "last";
    const replay = resumedUsageSession();
    try {
      replay.usage("prior", { total: usageTotals(1000, 100) });
      await replay.start("turn-1");
      const last = withLast ? { last: usageTotals(100, 10) } : {};
      for (let i = 1; i <= frames; i++)
        replay.usage("turn-1", { total: usageTotals(1000 + 100 * i, 100 + 10 * i), ...last });
      if (mode !== "plain") replay.usage("turn-1", { total: usageTotals(1100, 110), ...last });
      expect(replay.counts()).toHaveLength(withLast ? frames : 0);
      replay.finish("turn-1");
      const first = replay.counts();
      expect(first.reduce((sum, item) => sum + item.uncachedInputTokens, 0)).toBe(100 * frames);
      expect(first.reduce((sum, item) => sum + item.outputTokens, 0)).toBe(10 * frames);
      await replay.start("turn-2");
      replay.usage("turn-2", { total: usageTotals(1100 + 100 * frames, 110 + 10 * frames) });
      replay.finish("turn-2");
      expect(replay.counts().slice(first.length)).toEqual([crossTurnUsage]);
    } finally {
      await replay.session.dispose();
    }
  },
);
