import { expect, test } from "bun:test";
import {
  aggregateAgentTokenUsage,
  heatmapLevel,
  summarizeAgentTokenUsage,
  type AgentTokenUsageTurnSample,
} from "#src/features/agents/agent-token-usage-model";

function turn(
  overrides: Partial<AgentTokenUsageTurnSample> & { recordedAt: Date },
): AgentTokenUsageTurnSample {
  return {
    provider: "codex",
    model: "gpt-5.4",
    uncachedInputTokens: 100_000,
    cacheReadTokens: 800_000,
    cacheWriteTokens: 0,
    outputTokens: 2_000,
    contextUsedTokens: 48_000,
    contextWindowTokens: 200_000,
    ...overrides,
  };
}

test("groups turns by viewer time zone and computes consistent single-day drill-down", () => {
  const now = new Date("2026-11-24T02:00:00.000Z");
  const turns = [
    turn({
      recordedAt: new Date("2026-11-20T17:30:00.000Z"),
      uncachedInputTokens: 200_000,
      cacheReadTokens: 1_800_000,
      outputTokens: 3_000,
    }),
    turn({
      recordedAt: new Date("2026-11-19T06:00:00.000Z"),
      provider: "claude-code",
      model: "claude-sonnet-4-6",
      uncachedInputTokens: 50_000,
      cacheWriteTokens: 50_000,
      cacheReadTokens: 400_000,
      outputTokens: 1_000,
    }),
  ];

  const shanghai = aggregateAgentTokenUsage({
    turns,
    range: 7,
    timeZone: "Asia/Shanghai",
    now,
    trackingStartedAt: new Date("2026-11-10T00:00:00.000Z"),
    liveContextUsage: { usedTokens: 60_000, windowTokens: 200_000, observedAtMs: now.getTime() },
  });
  expect(shanghai.todayDateKey).toBe("2026-11-24");
  expect(shanghai.buckets).toHaveLength(7);
  expect(shanghai.buckets.find((b) => b.dateKey === "2026-11-21")?.effectiveTokens).toBe(203_000);
  expect(shanghai.buckets.find((b) => b.dateKey === "2026-11-19")?.newInputTokens).toBe(100_000);

  const la = aggregateAgentTokenUsage({
    turns,
    range: 7,
    timeZone: "America/Los_Angeles",
    now,
    trackingStartedAt: new Date("2026-11-10T00:00:00.000Z"),
    liveContextUsage: null,
  });
  expect(la.todayDateKey).toBe("2026-11-23");
  expect(la.buckets.find((b) => b.dateKey === "2026-11-20")?.effectiveTokens).toBe(203_000);

  const overall = summarizeAgentTokenUsage(shanghai, null);
  expect(overall.effectiveTokens).toBe(304_000);
  expect(overall.totalTokens).toBe(2_504_000);
  expect(overall.turns).toBe(2);
  expect(overall.avgEffectivePerTurn).toBe(152_000);
  expect(overall.avgTotalPerTurn).toBe(1_252_000);
  expect(overall.cacheHitPercent).toBe(88);
  expect(overall.models).toHaveLength(2);
  expect(overall.models[0]?.model).toBe("gpt-5.4");
  expect(overall.contextUsage).toEqual({ usedTokens: 60_000, windowTokens: 200_000 });

  const drilled = summarizeAgentTokenUsage(shanghai, "2026-11-21");
  expect(drilled.effectiveTokens).toBe(203_000);
  expect(drilled.turns).toBe(1);
  expect(drilled.models).toHaveLength(1);
  expect(drilled.contextUsage).toEqual({ usedTokens: 48_000, windowTokens: 200_000 });
});

test("supports 24-hour Today mode and suppresses delta when tracking started mid-period", () => {
  const now = new Date("2026-11-24T02:30:00.000Z");
  const turns = [
    turn({
      recordedAt: new Date("2026-11-24T01:15:00.000Z"),
      uncachedInputTokens: 40_000,
      cacheReadTokens: 160_000,
      outputTokens: 2_000,
    }),
    turn({
      recordedAt: new Date("2026-11-23T01:15:00.000Z"),
      uncachedInputTokens: 20_000,
      cacheReadTokens: 80_000,
      outputTokens: 1_000,
    }),
  ];

  const todayReport = aggregateAgentTokenUsage({
    turns,
    range: 1,
    timeZone: "Asia/Shanghai",
    now,
    trackingStartedAt: new Date("2026-11-20T00:00:00.000Z"),
    liveContextUsage: null,
  });
  expect(todayReport.buckets).toHaveLength(24);
  expect(todayReport.buckets[9]?.effectiveTokens).toBe(42_000);
  expect(todayReport.buckets[10]?.isCurrent).toBe(true);
  const summary = summarizeAgentTokenUsage(todayReport, null);
  expect(summary.deltaPercent).toBe(100);

  const turnsWithPreviousPeriod = [
    ...turns,
    turn({
      recordedAt: new Date("2026-11-16T06:00:00.000Z"),
      uncachedInputTokens: 20_000,
      cacheReadTokens: 80_000,
      outputTokens: 1_000,
    }),
  ];
  const partialPreviousTracking = aggregateAgentTokenUsage({
    turns: turnsWithPreviousPeriod,
    range: 7,
    timeZone: "UTC",
    now,
    trackingStartedAt: new Date("2026-11-16T00:00:00.000Z"),
    liveContextUsage: null,
  });
  expect(partialPreviousTracking.previousPeriod.effectiveTokens).toBe(21_000);
  expect(summarizeAgentTokenUsage(partialPreviousTracking, null).deltaPercent).toBeNull();

  const fullPreviousTracking = aggregateAgentTokenUsage({
    turns: turnsWithPreviousPeriod,
    range: 7,
    timeZone: "UTC",
    now,
    trackingStartedAt: new Date("2026-11-11T00:00:00.000Z"),
    liveContextUsage: null,
  });
  expect(summarizeAgentTokenUsage(fullPreviousTracking, null).deltaPercent).toBe(200);

  expect(heatmapLevel(0, 100)).toBe(0);
  expect(heatmapLevel(25, 100)).toBe(1);
  expect(heatmapLevel(50, 100)).toBe(2);
  expect(heatmapLevel(75, 100)).toBe(3);
  expect(heatmapLevel(100, 100)).toBe(4);
});
