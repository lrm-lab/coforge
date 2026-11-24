import { describe, expect, test } from "bun:test";
import {
  buildWorkspaceAgentUsageReport,
  summarizeWorkspaceAgentUsage,
} from "#src/features/agents/workspace-agent-usage-model";

describe("buildWorkspaceAgentUsageReport & summarizeWorkspaceAgentUsage", () => {
  const now = new Date("2026-11-24T06:30:00.000Z");

  const agents = [
    {
      id: "agent-a",
      displayName: "Frontend Bot",
      avatarUrl: null,
      model: "claude-sonnet-4-5",
      ownerId: "user-1",
      ownerDisplayName: "Alice",
    },
    {
      id: "agent-b",
      displayName: "Review Bot",
      avatarUrl: null,
      model: "gpt-5",
      ownerId: "user-2",
      ownerDisplayName: "Bob",
    },
    {
      id: "agent-c",
      displayName: "Idle Bot",
      avatarUrl: null,
      model: "gemini-2.5-pro",
      ownerId: "user-1",
      ownerDisplayName: "Alice",
    },
  ];

  test("aggregates team timeline, previous-period delta, model shares, per-agent team share, and single-day drill-down", () => {
    const report = buildWorkspaceAgentUsageReport({
      agents,
      slices: [
        {
          agentId: "agent-a",
          dateKey: "2026-11-23",
          hour: null,
          provider: "claude-code",
          model: "claude-opus-4-6",
          turns: 4,
          uncachedInputTokens: 600,
          cacheWriteTokens: 200,
          cacheReadTokens: 90_000,
          outputTokens: 200,
          contextUsedTokens: null,
          contextWindowTokens: null,
          contextRecordedAt: null,
        },
        {
          agentId: "agent-a",
          dateKey: "2026-11-24",
          hour: null,
          provider: "claude-code",
          model: "claude-sonnet-4-5",
          turns: 2,
          uncachedInputTokens: 150,
          cacheWriteTokens: 50,
          cacheReadTokens: 5_000,
          outputTokens: 50,
          contextUsedTokens: null,
          contextWindowTokens: null,
          contextRecordedAt: null,
        },
        {
          agentId: "agent-b",
          dateKey: "2026-11-24",
          hour: null,
          provider: "codex",
          model: "gpt-5",
          turns: 10,
          uncachedInputTokens: 2_000,
          cacheWriteTokens: 500,
          cacheReadTokens: 40_000,
          outputTokens: 1_250,
          contextUsedTokens: null,
          contextWindowTokens: null,
          contextRecordedAt: null,
        },
        {
          agentId: "agent-b",
          dateKey: "2026-11-15",
          hour: null,
          provider: "codex",
          model: "gpt-5",
          turns: 5,
          uncachedInputTokens: 1_500,
          cacheWriteTokens: 0,
          cacheReadTokens: 10_000,
          outputTokens: 1_000,
          contextUsedTokens: null,
          contextWindowTokens: null,
          contextRecordedAt: null,
        },
      ],
      range: 7,
      timeZone: "Asia/Shanghai",
      now,
      trackingStartedAt: new Date("2026-11-01T00:00:00.000Z"),
    });

    const full = summarizeWorkspaceAgentUsage(report, {
      selectedKey: null,
      owner: "all",
      viewerId: "user-1",
      query: "",
    });

    expect(full.teamEffectiveTokens).toBe(5_000);
    expect(full.visibleEffectiveTokens).toBe(5_000);
    expect(full.visibleTurns).toBe(16);
    expect(full.visibleActiveAgents).toBe(2);
    expect(full.timelineSummary.deltaPercent).toBe(100);
    expect(full.rows.map((r) => r.agentId)).toEqual(["agent-b", "agent-a", "agent-c"]);
    expect(full.rows[0]).toMatchObject({
      agentId: "agent-b",
      effectiveTokens: 3_750,
      teamSharePercent: 75,
      topModel: "gpt-5",
    });
    expect(full.rows[1]).toMatchObject({
      agentId: "agent-a",
      effectiveTokens: 1_250,
      teamSharePercent: 25,
      topModel: "claude-opus-4-6",
    });

    const filtered = summarizeWorkspaceAgentUsage(report, {
      selectedKey: null,
      owner: "mine",
      viewerId: "user-1",
      query: "front",
    });
    expect(filtered.rows.map((r) => r.agentId)).toEqual(["agent-a"]);
    expect(filtered.rows[0]?.teamSharePercent).toBe(25);

    const dayDrill = summarizeWorkspaceAgentUsage(report, {
      selectedKey: "2026-11-23",
      owner: "all",
      viewerId: "user-1",
      query: "",
    });
    expect(dayDrill.teamEffectiveTokens).toBe(1_000);
    expect(dayDrill.rows[0]).toMatchObject({
      agentId: "agent-a",
      effectiveTokens: 1_000,
      teamSharePercent: 100,
      turns: 4,
    });
    expect(dayDrill.rows.find((r) => r.agentId === "agent-b")?.effectiveTokens).toBe(0);
  });

  test("handles empty usage cleanly without NaN shares", () => {
    const report = buildWorkspaceAgentUsageReport({
      agents,
      slices: [],
      range: 1,
      timeZone: "UTC",
      now,
      trackingStartedAt: null,
    });

    const summary = summarizeWorkspaceAgentUsage(report, {
      selectedKey: null,
      owner: "all",
      viewerId: "user-1",
      query: "",
    });

    expect(summary.teamEffectiveTokens).toBe(0);
    expect(summary.visibleActiveAgents).toBe(0);
    expect(summary.rows.every((r) => r.teamSharePercent === 0)).toBe(true);
  });
});
