import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKSPACE_AGENT_USAGE_SORT,
  buildWorkspaceAgentUsageReport,
  sortWorkspaceAgentUsageRows,
  summarizeWorkspaceAgentUsage,
  toggleWorkspaceAgentUsageSort,
  type WorkspaceAgentUsageRow,
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
      ownerAvatarUrl: "/api/workspaces/w-1/members/user-1/avatar",
    },
    {
      id: "agent-b",
      displayName: "Review Bot",
      avatarUrl: null,
      model: "gpt-5",
      ownerId: "user-2",
      ownerDisplayName: "Bob",
      ownerAvatarUrl: null,
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
      ownerAvatarUrl: null,
    });
    expect(full.rows[1]).toMatchObject({
      agentId: "agent-a",
      effectiveTokens: 1_250,
      teamSharePercent: 25,
      topModel: "claude-opus-4-6",
      ownerAvatarUrl: "/api/workspaces/w-1/members/user-1/avatar",
    });

    const filtered = summarizeWorkspaceAgentUsage(report, {
      selectedKey: null,
      owner: "mine",
      viewerId: "user-1",
      query: "front",
    });
    expect(filtered.rows.map((r) => r.agentId)).toEqual(["agent-a"]);
    expect(filtered.rows[0]?.teamSharePercent).toBe(25);
    expect(filtered.timelineSummary.effectiveTokens).toBe(1_250);
    expect(filtered.timelineSummary.turns).toBe(6);
    expect(filtered.timelineSummary.peakKey).toBe("2026-11-23");
    expect(filtered.timelineSummary.peakEffective).toBe(1_000);
    expect(filtered.timelineBuckets.find((b) => b.key === "2026-11-24")?.effectiveTokens).toBe(250);
    expect(filtered.timelineBuckets.find((b) => b.key === "2026-11-23")?.effectiveTokens).toBe(
      1_000,
    );
    expect(filtered.timelineSummary.models).toEqual([
      {
        provider: "claude-code",
        model: "claude-opus-4-6",
        effectiveTokens: 1_000,
        totalTokens: 91_000,
        turns: 4,
        sharePercent: 80,
      },
      {
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        effectiveTokens: 250,
        totalTokens: 5_250,
        turns: 2,
        sharePercent: 20,
      },
    ]);

    const filteredDayDrill = summarizeWorkspaceAgentUsage(report, {
      selectedKey: "2026-11-24",
      owner: "mine",
      viewerId: "user-1",
      query: "front",
    });
    expect(filteredDayDrill.visibleEffectiveTokens).toBe(250);
    expect(
      filteredDayDrill.timelineBuckets.find((b) => b.key === "2026-11-23")?.effectiveTokens,
    ).toBe(1_000);
    expect(filteredDayDrill.timelineSummary.models).toEqual([
      {
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        effectiveTokens: 250,
        totalTokens: 5_250,
        turns: 2,
        sharePercent: 100,
      },
    ]);

    const emptyMatch = summarizeWorkspaceAgentUsage(report, {
      selectedKey: null,
      owner: "all",
      viewerId: "user-1",
      query: "nonexistent",
    });
    expect(emptyMatch.rows).toEqual([]);
    expect(emptyMatch.visibleEffectiveTokens).toBe(0);
    expect(emptyMatch.timelineSummary.models).toEqual([]);
    expect(emptyMatch.timelineBuckets.every((b) => b.effectiveTokens === 0)).toBe(true);
    expect(emptyMatch.teamEffectiveTokens).toBe(5_000);

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

  test("preserves archived agent usage in totals while hiding archived agents with zero usage in the selected window", () => {
    const report = buildWorkspaceAgentUsageReport({
      agents: [
        agents[0]!,
        {
          id: "agent-archived-used",
          displayName: "Retired Worker",
          avatarUrl: null,
          model: "gpt-5",
          ownerId: "user-2",
          ownerDisplayName: "Bob",
          archived: true,
        },
        {
          id: "agent-archived-old",
          displayName: "Ancient Worker",
          avatarUrl: null,
          model: "gpt-4.1",
          ownerId: "user-2",
          ownerDisplayName: "Bob",
          archived: true,
        },
      ],
      slices: [
        {
          agentId: "agent-a",
          dateKey: "2026-11-24",
          hour: null,
          provider: "claude-code",
          model: "claude-sonnet-4-5",
          turns: 2,
          uncachedInputTokens: 300,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 200,
          contextUsedTokens: null,
          contextWindowTokens: null,
          contextRecordedAt: null,
        },
        {
          agentId: "agent-archived-used",
          dateKey: "2026-11-23",
          hour: null,
          provider: "codex",
          model: "gpt-5",
          turns: 3,
          uncachedInputTokens: 1_000,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 500,
          contextUsedTokens: null,
          contextWindowTokens: null,
          contextRecordedAt: null,
        },
        {
          agentId: "agent-archived-old",
          dateKey: "2026-11-15",
          hour: null,
          provider: "codex",
          model: "gpt-4.1",
          turns: 2,
          uncachedInputTokens: 600,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 400,
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
    expect(full.teamEffectiveTokens).toBe(2_000);
    expect(full.timelineSummary.deltaPercent).toBe(100);
    expect(full.rows.map((r) => [r.agentId, r.archived])).toEqual([
      ["agent-archived-used", true],
      ["agent-a", false],
    ]);

    const nov24 = summarizeWorkspaceAgentUsage(report, {
      selectedKey: "2026-11-24",
      owner: "all",
      viewerId: "user-1",
      query: "",
    });
    expect(nov24.rows.map((r) => r.agentId)).toEqual(["agent-a"]);
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

function makeUsageRow(
  overrides: Partial<WorkspaceAgentUsageRow> &
    Pick<WorkspaceAgentUsageRow, "agentId" | "displayName">,
): WorkspaceAgentUsageRow {
  return {
    avatarUrl: null,
    ownerId: "user-1",
    ownerDisplayName: "Alice",
    ownerAvatarUrl: null,
    archived: false,
    effectiveTokens: 0,
    newInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    topModel: "",
    teamSharePercent: 0,
    ...overrides,
  };
}

describe("toggleWorkspaceAgentUsageSort", () => {
  test("defaults to tokens descending and picks smart initial directions per column", () => {
    expect(DEFAULT_WORKSPACE_AGENT_USAGE_SORT).toEqual({ key: "tokens", direction: "desc" });

    expect(toggleWorkspaceAgentUsageSort(DEFAULT_WORKSPACE_AGENT_USAGE_SORT, "tokens")).toEqual({
      key: "tokens",
      direction: "asc",
    });
    expect(toggleWorkspaceAgentUsageSort({ key: "tokens", direction: "asc" }, "tokens")).toEqual({
      key: "tokens",
      direction: "desc",
    });

    expect(toggleWorkspaceAgentUsageSort(DEFAULT_WORKSPACE_AGENT_USAGE_SORT, "turns")).toEqual({
      key: "turns",
      direction: "desc",
    });
    expect(toggleWorkspaceAgentUsageSort({ key: "turns", direction: "desc" }, "turns")).toEqual({
      key: "turns",
      direction: "asc",
    });

    expect(toggleWorkspaceAgentUsageSort(DEFAULT_WORKSPACE_AGENT_USAGE_SORT, "agent")).toEqual({
      key: "agent",
      direction: "asc",
    });
    expect(toggleWorkspaceAgentUsageSort({ key: "agent", direction: "asc" }, "agent")).toEqual({
      key: "agent",
      direction: "desc",
    });

    expect(toggleWorkspaceAgentUsageSort(DEFAULT_WORKSPACE_AGENT_USAGE_SORT, "model")).toEqual({
      key: "model",
      direction: "asc",
    });
    expect(toggleWorkspaceAgentUsageSort(DEFAULT_WORKSPACE_AGENT_USAGE_SORT, "owner")).toEqual({
      key: "owner",
      direction: "asc",
    });
    expect(toggleWorkspaceAgentUsageSort({ key: "agent", direction: "asc" }, "tokens")).toEqual({
      key: "tokens",
      direction: "desc",
    });
  });
});

describe("sortWorkspaceAgentUsageRows", () => {
  const sampleRows: WorkspaceAgentUsageRow[] = [
    makeUsageRow({
      agentId: "agent-3",
      displayName: "zeta bot",
      effectiveTokens: 500,
      turns: 20,
      topModel: "gpt-5",
      ownerId: "user-2",
      ownerDisplayName: "Bob",
    }),
    makeUsageRow({
      agentId: "agent-1",
      displayName: "Alpha Bot",
      effectiveTokens: 3_000,
      turns: 5,
      topModel: "claude-opus-4-6",
      ownerId: "user-1",
      ownerDisplayName: "Alice",
    }),
    makeUsageRow({
      agentId: "agent-2",
      displayName: "beta bot",
      effectiveTokens: 3_000,
      turns: 8,
      topModel: "",
      ownerId: "user-3",
      ownerDisplayName: "charlie",
    }),
    makeUsageRow({
      agentId: "agent-4",
      displayName: "Alpha Bot",
      effectiveTokens: 1_200,
      turns: 8,
      topModel: "claude-opus-4-6",
      ownerId: "user-1",
      ownerDisplayName: "Alice",
    }),
    makeUsageRow({
      agentId: "agent-5",
      displayName: "Idle Bot",
      effectiveTokens: 0,
      turns: 0,
      topModel: "   ",
      ownerId: "user-2",
      ownerDisplayName: "Bob",
    }),
  ];

  test("does not mutate input rows and sorts by tokens with deterministic tie-breakers", () => {
    const originalIds = sampleRows.map((row) => row.agentId);

    const desc = sortWorkspaceAgentUsageRows(
      sampleRows,
      { key: "tokens", direction: "desc" },
      "en",
    );
    expect(sampleRows.map((row) => row.agentId)).toEqual(originalIds);
    expect(desc.map((row) => row.agentId)).toEqual([
      "agent-2",
      "agent-1",
      "agent-4",
      "agent-3",
      "agent-5",
    ]);

    const asc = sortWorkspaceAgentUsageRows(sampleRows, { key: "tokens", direction: "asc" }, "en");
    expect(asc.map((row) => row.agentId)).toEqual([
      "agent-5",
      "agent-3",
      "agent-4",
      "agent-2",
      "agent-1",
    ]);
  });

  test("sorts by turns and breaks ties by effectiveTokens desc then displayName then agentId", () => {
    const desc = sortWorkspaceAgentUsageRows(sampleRows, { key: "turns", direction: "desc" }, "en");
    expect(desc.map((row) => row.agentId)).toEqual([
      "agent-3",
      "agent-2",
      "agent-4",
      "agent-1",
      "agent-5",
    ]);

    const asc = sortWorkspaceAgentUsageRows(sampleRows, { key: "turns", direction: "asc" }, "en");
    expect(asc.map((row) => row.agentId)).toEqual([
      "agent-5",
      "agent-1",
      "agent-2",
      "agent-4",
      "agent-3",
    ]);
  });

  test("sorts by agent name case-insensitively and breaks ties deterministically", () => {
    const asc = sortWorkspaceAgentUsageRows(sampleRows, { key: "agent", direction: "asc" }, "en");
    expect(asc.map((row) => row.agentId)).toEqual([
      "agent-1",
      "agent-4",
      "agent-2",
      "agent-5",
      "agent-3",
    ]);

    const desc = sortWorkspaceAgentUsageRows(sampleRows, { key: "agent", direction: "desc" }, "en");
    expect(desc.map((row) => row.agentId)).toEqual([
      "agent-3",
      "agent-5",
      "agent-2",
      "agent-1",
      "agent-4",
    ]);

    const identicalTies = [
      makeUsageRow({ agentId: "id-b", displayName: "Same", effectiveTokens: 100, turns: 2 }),
      makeUsageRow({ agentId: "id-a", displayName: "Same", effectiveTokens: 100, turns: 2 }),
    ];
    expect(
      sortWorkspaceAgentUsageRows(identicalTies, { key: "agent", direction: "asc" }, "en").map(
        (row) => row.agentId,
      ),
    ).toEqual(["id-a", "id-b"]);
  });

  test("sorts by model with empty models always last and tokens desc tie-breaker", () => {
    const asc = sortWorkspaceAgentUsageRows(sampleRows, { key: "model", direction: "asc" }, "en");
    expect(asc.map((row) => row.agentId)).toEqual([
      "agent-1",
      "agent-4",
      "agent-3",
      "agent-2",
      "agent-5",
    ]);

    const desc = sortWorkspaceAgentUsageRows(sampleRows, { key: "model", direction: "desc" }, "en");
    expect(desc.map((row) => row.agentId)).toEqual([
      "agent-3",
      "agent-1",
      "agent-4",
      "agent-2",
      "agent-5",
    ]);
  });

  test("sorts by owner with tokens desc tie-breaker and empty owners last", () => {
    const asc = sortWorkspaceAgentUsageRows(sampleRows, { key: "owner", direction: "asc" }, "en");
    expect(asc.map((row) => row.agentId)).toEqual([
      "agent-1",
      "agent-4",
      "agent-3",
      "agent-5",
      "agent-2",
    ]);

    const desc = sortWorkspaceAgentUsageRows(sampleRows, { key: "owner", direction: "desc" }, "en");
    expect(desc.map((row) => row.agentId)).toEqual([
      "agent-2",
      "agent-3",
      "agent-5",
      "agent-1",
      "agent-4",
    ]);

    const withMissingOwner = [
      makeUsageRow({ agentId: "a", displayName: "A", ownerDisplayName: "", effectiveTokens: 900 }),
      makeUsageRow({
        agentId: "b",
        displayName: "B",
        ownerDisplayName: "Zoe",
        effectiveTokens: 10,
      }),
    ];
    expect(
      sortWorkspaceAgentUsageRows(withMissingOwner, { key: "owner", direction: "asc" }, "en").map(
        (row) => row.agentId,
      ),
    ).toEqual(["b", "a"]);
    expect(
      sortWorkspaceAgentUsageRows(withMissingOwner, { key: "owner", direction: "desc" }, "en").map(
        (row) => row.agentId,
      ),
    ).toEqual(["b", "a"]);
  });

  test("sorts CJK names according to locale collation", () => {
    const cjkRows = [
      makeUsageRow({ agentId: "z", displayName: "张飞", ownerDisplayName: "赵云" }),
      makeUsageRow({ agentId: "a", displayName: "阿斗", ownerDisplayName: "安琪" }),
      makeUsageRow({ agentId: "b", displayName: "白起", ownerDisplayName: "包拯" }),
    ];

    expect(
      sortWorkspaceAgentUsageRows(cjkRows, { key: "agent", direction: "asc" }, "zh-CN").map(
        (row) => row.agentId,
      ),
    ).toEqual(["a", "b", "z"]);
    expect(
      sortWorkspaceAgentUsageRows(cjkRows, { key: "owner", direction: "desc" }, "zh-CN").map(
        (row) => row.agentId,
      ),
    ).toEqual(["z", "b", "a"]);
  });
});
