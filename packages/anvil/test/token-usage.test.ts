import { expect, test } from "bun:test";
import { acpPromptTokenUsage } from "#src/acp-context-usage";
import { ClaudeSessionObservations, claudeTurnTokenUsage } from "#src/claude-code/observations";
import { CodexTokenUsageTracker } from "#src/codex/context-usage";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import { piSessionEvents, type PiSessionEvent } from "#src/pi/session-events";

test("claudeTurnTokenUsage extracts full-turn usage, model, and context window", () => {
  const record = {
    type: "result",
    timestamp: "2026-11-24T02:00:00.000Z",
    usage: {
      input_tokens: 1_500,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 3_200,
      output_tokens: 680,
      iterations: [
        {
          type: "message",
          input_tokens: 500,
          cache_read_input_tokens: 20_000,
          cache_creation_input_tokens: 1_000,
          output_tokens: 300,
        },
      ],
    },
    modelUsage: {
      "claude-sonnet-4-6": {
        inputTokens: 1_500,
        cacheReadInputTokens: 40_000,
        cacheCreationInputTokens: 3_200,
        contextWindow: 200_000,
      },
    },
  };
  const observations = new ClaudeSessionObservations("claude-sonnet-4-6");
  const events = [...observations.read(record, "sess-1")];
  const tokenEvent = events.find((e) => e.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE);
  expect(tokenEvent).toEqual({
    type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
    usage: {
      uncachedInputTokens: 1_500,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 3_200,
      outputTokens: 680,
      model: "claude-sonnet-4-6",
      contextUsedTokens: 21_500,
      contextWindowTokens: 200_000,
      occurredAt: "2026-11-24T02:00:00.000Z",
    },
  });
  expect(claudeTurnTokenUsage({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeUndefined();
});

test("CodexTokenUsageTracker prevents resumed-thread leakage and duplicate counting", () => {
  const tracker = new CodexTokenUsageTracker();
  const resumedFirst = tracker.accept(
    {
      tokenUsage: {
        total: {
          inputTokens: 502_000,
          cachedInputTokens: 480_000,
          outputTokens: 12_500,
          reasoningOutputTokens: 3_100,
        },
        last: {
          inputTokens: 2_000,
          cachedInputTokens: 1_600,
          outputTokens: 500,
          reasoningOutputTokens: 100,
        },
      },
    },
    { usedTokens: 2_500, windowTokens: 200_000 },
    "gpt-5.4",
  );
  expect(resumedFirst).toEqual({
    uncachedInputTokens: 400,
    cacheReadTokens: 1_600,
    cacheWriteTokens: 0,
    outputTokens: 500,
    reasoningOutputTokens: 100,
    model: "gpt-5.4",
    contextUsedTokens: 2_500,
    contextWindowTokens: 200_000,
  });

  const duplicate = tracker.accept({
    tokenUsage: {
      total: {
        inputTokens: 502_000,
        cachedInputTokens: 480_000,
        outputTokens: 12_500,
        reasoningOutputTokens: 3_100,
      },
      last: {
        inputTokens: 2_000,
        cachedInputTokens: 1_600,
        outputTokens: 500,
        reasoningOutputTokens: 100,
      },
    },
  });
  expect(duplicate).toBeUndefined();

  const second = tracker.accept(
    {
      tokenUsage: {
        total: {
          inputTokens: 505_000,
          cachedInputTokens: 482_400,
          outputTokens: 13_100,
          reasoningOutputTokens: 3_300,
        },
        last: {
          inputTokens: 3_000,
          cachedInputTokens: 2_400,
          outputTokens: 600,
          reasoningOutputTokens: 200,
        },
      },
    },
    { usedTokens: 3_600, windowTokens: 200_000 },
    "gpt-5.4",
  );
  expect(second).toEqual({
    uncachedInputTokens: 600,
    cacheReadTokens: 2_400,
    cacheWriteTokens: 0,
    outputTokens: 600,
    reasoningOutputTokens: 200,
    model: "gpt-5.4",
    contextUsedTokens: 3_600,
    contextWindowTokens: 200_000,
  });
});

test("piSessionEvents emits token-usage on completed assistant messages even without windowTokens", () => {
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      model: "claude-sonnet-4-6",
      usage: {
        input: 1_200,
        cacheRead: 8_000,
        cacheWrite: 300,
        output: 450,
        totalTokens: 9_950,
      },
    },
  } as unknown as PiSessionEvent;
  const events = piSessionEvents(event);
  expect(events).toEqual([
    {
      type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
      usage: {
        uncachedInputTokens: 1_200,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 300,
        outputTokens: 450,
        model: "claude-sonnet-4-6",
      },
    },
  ]);
});

test("acpPromptTokenUsage parses prompt usage payloads safely", () => {
  expect(
    acpPromptTokenUsage({
      stopReason: "end_turn",
      usage: {
        totalTokens: 12_500,
        inputTokens: 12_000,
        cachedReadTokens: 9_000,
        cachedWriteTokens: 500,
        outputTokens: 500,
        thoughtTokens: 120,
      },
    }),
  ).toEqual({
    uncachedInputTokens: 2_500,
    cacheReadTokens: 9_000,
    cacheWriteTokens: 500,
    outputTokens: 500,
    reasoningOutputTokens: 120,
  });
  expect(acpPromptTokenUsage({ stopReason: "end_turn" })).toBeUndefined();
});
