import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { codexContextUsage } from "@lrm/coforge-anvil/codex";
import { scenarioProvider, waitForEvent } from "./codex-scenarios";

// The context a Codex session holds is its last model request's total tokens, not the thread's
// cumulative total, which grows past the window within a few turns (Raft 1.0.59 / oar 0.76,
// task #339). Shape: `ThreadTokenUsage` from `codex app-server generate-ts` (codex-cli 0.165.0).

const usage = (last: number, total: number, window: number | null) => ({
  tokenUsage: {
    last: { totalTokens: last, inputTokens: last - 255, cachedInputTokens: 0, outputTokens: 255 },
    total: { totalTokens: total, inputTokens: total, cachedInputTokens: 0, outputTokens: 0 },
    modelContextWindow: window,
  },
});

test("context usage is the last request's total tokens against the model's window", () => {
  expect(codexContextUsage(usage(236_574, 6_900_000, 258_400))).toEqual({
    usedTokens: 236_574,
    windowTokens: 258_400,
  });
});

test("no reading without a window; a zero or past-the-window count is reported as is, like Raft", () => {
  expect(codexContextUsage(usage(236_574, 6_900_000, null))).toBeUndefined();
  expect(codexContextUsage(usage(0, 6_900_000, 258_400))).toEqual({
    usedTokens: 0,
    windowTokens: 258_400,
  });
  expect(codexContextUsage(usage(300_000, 6_900_000, 258_400))).toEqual({
    usedTokens: 300_000,
    windowTokens: 258_400,
  });
  expect(codexContextUsage({ tokenUsage: {} })).toBeUndefined();
  expect(codexContextUsage(undefined)).toBeUndefined();
});

test("a Codex session reports the last request's context as its context usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-codex-context-"));
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("token-usage");
    await waitForEvent(events, "completed");
    expect(events.filter((event) => event.type === "context-usage")).toEqual([
      { type: "context-usage", usedTokens: 120_000, windowTokens: 258_400 },
    ]);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("token usage from another thread or after the turn completed is not a reading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-codex-context-"));
  const session = await scenarioProvider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("token-usage-foreign");
    await waitForEvent(events, "completed");
    await Bun.sleep(50);
    expect(events.filter((event) => event.type === "context-usage")).toEqual([]);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
