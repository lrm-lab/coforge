import { expect, test } from "bun:test";
import {
  aggregateAgentTokenUsage,
  heatmapLevel,
  resolveDefaultUsageProvider,
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
    currentProvider: "claude-code",
  });
  expect(shanghai.todayDateKey).toBe("2026-11-24");
  expect(shanghai.currentProvider).toBe("claude-code");
  expect(shanghai.buckets).toHaveLength(7);
  expect(shanghai.buckets.find((b) => b.dateKey === "2026-11-21")?.effectiveTokens).toBe(203_000);
  expect(shanghai.buckets.find((b) => b.dateKey === "2026-11-21")?.cacheHitPercent).toBe(90);
  expect(shanghai.buckets.find((b) => b.dateKey === "2026-11-19")?.newInputTokens).toBe(100_000);
  expect(shanghai.buckets.find((b) => b.dateKey === "2026-11-19")?.cacheHitPercent).toBe(80);
  expect(shanghai.buckets.find((b) => b.dateKey === "2026-11-22")?.cacheHitPercent).toBeNull();

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

  const overall = summarizeAgentTokenUsage(shanghai, null, null);
  expect(overall.effectiveTokens).toBe(304_000);
  expect(overall.totalTokens).toBe(2_504_000);
  expect(overall.turns).toBe(2);
  expect(overall.avgEffectivePerTurn).toBe(152_000);
  expect(overall.avgTotalPerTurn).toBe(1_252_000);
  expect(overall.cacheHitPercent).toBeNull();
  expect(overall.cacheHitSeries.every((v) => v === null)).toBe(true);
  expect(overall.runtimes.map((r) => [r.provider, r.isCurrent, r.cacheHitPercent])).toEqual([
    ["claude-code", true, 80],
    ["codex", false, 90],
  ]);
  expect(overall.models).toHaveLength(2);
  expect(overall.models[0]).toMatchObject({
    provider: "codex",
    model: "gpt-5.4",
    uncachedInputTokens: 200_000,
    cacheWriteTokens: 0,
    newInputTokens: 200_000,
    cacheReadTokens: 1_800_000,
    outputTokens: 3_000,
    cacheHitPercent: 90,
  });
  expect(overall.models[1]).toMatchObject({
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    uncachedInputTokens: 50_000,
    cacheWriteTokens: 50_000,
    newInputTokens: 100_000,
    cacheReadTokens: 400_000,
    outputTokens: 1_000,
    cacheHitPercent: 80,
  });
  expect(overall.contextUsage).toEqual({ usedTokens: 60_000, windowTokens: 200_000 });

  const drilled = summarizeAgentTokenUsage(shanghai, "2026-11-21", null);
  expect(drilled.effectiveTokens).toBe(203_000);
  expect(drilled.turns).toBe(1);
  expect(drilled.cacheHitPercent).toBe(90);
  expect(drilled.models).toHaveLength(1);
  expect(drilled.contextUsage).toEqual({ usedTokens: 48_000, windowTokens: 200_000 });
});

test("isolates buckets, series, cacheHitSeries, models, and deltaPercent to a selected runtime", () => {
  const now = new Date("2026-11-24T12:00:00.000Z");
  const turns = [
    turn({
      recordedAt: new Date("2026-11-24T09:00:00.000Z"),
      provider: "grok",
      model: "grok-4",
      uncachedInputTokens: 300_000,
      cacheWriteTokens: 96_000,
      cacheReadTokens: 828_000,
      outputTokens: 86_000,
    }),
    turn({
      recordedAt: new Date("2026-11-22T09:00:00.000Z"),
      provider: "grok",
      model: "grok-4-fast",
      uncachedInputTokens: 71_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 122_000,
      outputTokens: 23_000,
    }),
    turn({
      recordedAt: new Date("2026-11-22T10:00:00.000Z"),
      provider: "claude-code",
      model: "claude-sonnet-4",
      uncachedInputTokens: 200_000,
      cacheWriteTokens: 38_000,
      cacheReadTokens: 1_870_000,
      outputTokens: 72_000,
    }),
    turn({
      recordedAt: new Date("2026-11-21T10:00:00.000Z"),
      provider: "codex",
      model: "gpt-5.3-codex",
      uncachedInputTokens: 98_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 422_000,
      outputTokens: 28_000,
    }),
    turn({
      recordedAt: new Date("2026-11-14T10:00:00.000Z"),
      provider: "grok",
      model: "grok-4",
      uncachedInputTokens: 200_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 400_000,
      outputTokens: 88_000,
    }),
    turn({
      recordedAt: new Date("2026-11-14T11:00:00.000Z"),
      provider: "claude-code",
      model: "claude-sonnet-4",
      uncachedInputTokens: 500_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 1_000_000,
      outputTokens: 120_000,
    }),
  ];

  const report = aggregateAgentTokenUsage({
    turns,
    range: 7,
    timeZone: "UTC",
    now,
    trackingStartedAt: new Date("2026-11-01T00:00:00.000Z"),
    liveContextUsage: null,
    currentProvider: "grok",
  });

  expect(report.previousPeriodByProvider.grok?.effectiveTokens).toBe(288_000);
  expect(report.previousPeriodByProvider["claude-code"]?.effectiveTokens).toBe(620_000);

  const grok = summarizeAgentTokenUsage(report, null, "grok");
  expect(grok.effectiveTokens).toBe(576_000);
  expect(grok.newInputTokens).toBe(467_000);
  expect(grok.cacheWriteTokens).toBe(96_000);
  expect(grok.cacheReadTokens).toBe(950_000);
  expect(grok.outputTokens).toBe(109_000);
  expect(grok.totalTokens).toBe(1_526_000);
  expect(grok.cacheHitPercent).toBe(67);
  expect(grok.deltaPercent).toBe(100);
  expect(grok.models.map((m) => m.model)).toEqual(["grok-4", "grok-4-fast"]);
  expect(grok.models[0]?.cacheWriteTokens).toBe(96_000);
  expect(grok.models[0]?.sharePercent).toBe(83.7);
  expect(grok.models[1]?.sharePercent).toBe(16.3);
  expect(grok.reportRuntimes.map((r) => r.provider)).toEqual(["grok", "claude-code", "codex"]);
  expect(grok.runtimes.map((r) => r.provider)).toEqual(["grok"]);

  const day22Index = grok.buckets.findIndex((b) => b.dateKey === "2026-11-22");
  const day21Index = grok.buckets.findIndex((b) => b.dateKey === "2026-11-21");
  const day24Index = grok.buckets.findIndex((b) => b.dateKey === "2026-11-24");
  expect(grok.buckets[day22Index]?.effectiveTokens).toBe(94_000);
  expect(grok.buckets[day21Index]?.effectiveTokens).toBe(0);
  expect(grok.series.effective[day22Index]).toBe(94_000);
  expect(grok.series.effective[day21Index]).toBe(0);
  expect(grok.cacheHitSeries[day22Index]).toBe(63.2);
  expect(grok.cacheHitSeries[day21Index]).toBeNull();
  expect(grok.cacheHitSeries[day24Index]).toBe(67.6);

  const grokOnCodexDay = summarizeAgentTokenUsage(report, "2026-11-21", "grok");
  expect(grokOnCodexDay.effectiveTokens).toBe(0);
  expect(grokOnCodexDay.turns).toBe(0);
  expect(grokOnCodexDay.cacheHitPercent).toBeNull();
  expect(grokOnCodexDay.models).toEqual([]);

  const claude = summarizeAgentTokenUsage(report, null, "claude-code");
  expect(claude.effectiveTokens).toBe(310_000);
  expect(claude.cacheHitPercent).toBe(88.7);
  expect(claude.deltaPercent).toBe(-50);

  const all = summarizeAgentTokenUsage(report, null, null);
  expect(all.cacheHitPercent).toBeNull();
  expect(all.cacheHitSeries.every((v) => v === null)).toBe(true);
  expect(all.runtimes.map((r) => [r.provider, r.isCurrent, r.cacheHitPercent])).toEqual([
    ["grok", true, 67],
    ["claude-code", false, 88.7],
    ["codex", false, 81.2],
  ]);
});

test("resolves default provider for current runtime, sole runtime, or all runtimes", () => {
  const now = new Date("2026-11-24T12:00:00.000Z");

  const multiWithCurrent = aggregateAgentTokenUsage({
    turns: [
      turn({ recordedAt: now, provider: "grok", model: "grok-4" }),
      turn({ recordedAt: now, provider: "codex", model: "gpt-5.4" }),
    ],
    range: 7,
    timeZone: "UTC",
    now,
    trackingStartedAt: null,
    liveContextUsage: null,
    currentProvider: "grok",
  });
  expect(
    resolveDefaultUsageProvider(
      summarizeAgentTokenUsage(multiWithCurrent, null).reportRuntimes,
      multiWithCurrent.currentProvider,
    ),
  ).toBe("grok");

  const singleHistorical = aggregateAgentTokenUsage({
    turns: [turn({ recordedAt: now, provider: "codex", model: "gpt-5.4" })],
    range: 7,
    timeZone: "UTC",
    now,
    trackingStartedAt: null,
    liveContextUsage: null,
    currentProvider: "grok",
  });
  const singleSummary = summarizeAgentTokenUsage(singleHistorical, null);
  expect(resolveDefaultUsageProvider(singleSummary.reportRuntimes, "grok")).toBe("codex");
  expect(singleSummary.cacheHitPercent).toBe(88.9);
  expect(singleSummary.cacheHitSeries.filter((v) => v !== null)).toEqual([88.9]);

  const multiHistorical = aggregateAgentTokenUsage({
    turns: [
      turn({ recordedAt: now, provider: "claude-code", model: "claude-sonnet-4" }),
      turn({ recordedAt: now, provider: "codex", model: "gpt-5.4" }),
    ],
    range: 7,
    timeZone: "UTC",
    now,
    trackingStartedAt: null,
    liveContextUsage: null,
    currentProvider: "grok",
  });
  expect(
    resolveDefaultUsageProvider(
      summarizeAgentTokenUsage(multiHistorical, null).reportRuntimes,
      "grok",
    ),
  ).toBeNull();
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
  expect(todayReport.buckets[9]?.cacheHitPercent).toBe(80);
  expect(todayReport.buckets[10]?.isCurrent).toBe(true);
  const summary = summarizeAgentTokenUsage(todayReport, null);
  expect(summary.deltaPercent).toBe(100);
  expect(summary.cacheHitPercent).toBe(80);
  expect(summary.cacheHitSeries[9]).toBe(80);
  expect(summary.cacheHitSeries[10]).toBeNull();

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
