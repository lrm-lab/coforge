import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { claudePromptCacheUsage } from "@lrm/coforge-anvil/claude-code";
import { codexPromptCacheUsage } from "@lrm/coforge-anvil/codex";
import { piPromptCacheUsage } from "@lrm/coforge-anvil/pi";
import { scenarioProvider, waitForEvent } from "./codex-scenarios";
import {
  claudeFixtureProvider,
  TEST_AGENT_INSTRUCTIONS,
  waitForEvent as waitForClaudeEvent,
} from "./fixtures/claude-feed";
import { captureDaemonLogs } from "./fixtures/log-capture";

test("codexPromptCacheUsage parses last token usage and computes cache hit ratio", () => {
  expect(
    codexPromptCacheUsage({
      tokenUsage: {
        last: {
          inputTokens: 100_000,
          cachedInputTokens: 82_500,
          cacheWriteInputTokens: 7_500,
          outputTokens: 1_200,
          reasoningOutputTokens: 400,
          totalTokens: 101_200,
        },
        modelContextWindow: 258_400,
      },
    }),
  ).toEqual({
    inputTokens: 100_000,
    cachedInputTokens: 82_500,
    cacheWriteInputTokens: 7_500,
    uncachedInputTokens: 10_000,
    outputTokens: 1_200,
    reasoningOutputTokens: 400,
    cacheHitRatio: 0.825,
  });
});

test("codexPromptCacheUsage ignores synthetic zero or missing input readings", () => {
  expect(
    codexPromptCacheUsage({
      tokenUsage: {
        last: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        modelContextWindow: 258_400,
      },
    }),
  ).toBeUndefined();
  expect(codexPromptCacheUsage({ tokenUsage: {} })).toBeUndefined();
  expect(codexPromptCacheUsage(undefined)).toBeUndefined();
});

test("claudePromptCacheUsage reads the last message iteration and computes cache hit ratio", () => {
  expect(
    claudePromptCacheUsage({
      type: "result",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 14_102,
        cache_creation_input_tokens: 13_796,
        output_tokens: 59,
        iterations: [
          {
            type: "message",
            input_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 900,
            output_tokens: 10,
          },
          {
            type: "message",
            input_tokens: 10,
            cache_read_input_tokens: 14_102,
            cache_creation_input_tokens: 13_796,
            output_tokens: 59,
          },
        ],
      },
    }),
  ).toEqual({
    inputTokens: 27_908,
    cachedInputTokens: 14_102,
    cacheWriteInputTokens: 13_796,
    uncachedInputTokens: 10,
    outputTokens: 59,
    cacheHitRatio: 0.5053,
  });

  expect(claudePromptCacheUsage({ type: "result", usage: { input_tokens: 0 } })).toBeUndefined();
});

test("piPromptCacheUsage sums uncached, cacheRead and cacheWrite input tokens", () => {
  expect(
    piPromptCacheUsage({
      input: 1_500,
      cacheRead: 18_000,
      cacheWrite: 500,
      output: 320,
      totalTokens: 20_320,
    }),
  ).toEqual({
    inputTokens: 20_000,
    cachedInputTokens: 18_000,
    cacheWriteInputTokens: 500,
    uncachedInputTokens: 1_500,
    outputTokens: 320,
    cacheHitRatio: 0.9,
  });

  expect(piPromptCacheUsage({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeUndefined();
  expect(piPromptCacheUsage(undefined)).toBeUndefined();
});

test("Codex session logs structured prompt cache usage on thread/tokenUsage/updated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-codex-cache-log-"));
  try {
    const { records } = await captureDaemonLogs(async () => {
      const session = await scenarioProvider().createAgentSession({
        agentWorkspaceDirectory: directory,
        instructions: "Test.",
        agentId: "agent-1",
        runtimeId: "runtime-1",
      });
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        await session.sendMessage("token-usage");
        await waitForEvent(events, "completed");
      } finally {
        await session.dispose();
      }
    });
    const entry = records.find((record) => record.properties.event === "codex.prompt_cache.usage");
    expect(entry?.properties).toMatchObject({
      event: "codex.prompt_cache.usage",
      agent_id: "agent-1",
      runtime_id: "runtime-1",
      input_tokens: 120_000,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      uncached_input_tokens: 120_000,
      cache_hit_ratio: 0,
      used_tokens: 120_000,
      window_tokens: 258_400,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude Code session logs structured prompt cache usage on result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-claude-cache-log-"));
  try {
    const { records } = await captureDaemonLogs(async () => {
      const session = await claudeFixtureProvider().createAgentSession({
        agentWorkspaceDirectory: directory,
        instructions: TEST_AGENT_INSTRUCTIONS,
      });
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        await session.sendMessage("context-usage");
        await waitForClaudeEvent(events, "completed");
      } finally {
        await session.dispose();
      }
    });
    const entry = records.find(
      (record) => record.properties.event === "claude_code.prompt_cache.usage",
    );
    expect(entry?.properties).toMatchObject({
      event: "claude_code.prompt_cache.usage",
      input_tokens: 27_908,
      cached_input_tokens: 14_102,
      cache_write_input_tokens: 13_796,
      uncached_input_tokens: 10,
      output_tokens: 59,
      cache_hit_ratio: 0.5053,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
