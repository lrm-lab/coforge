import { describe, expect, test } from "bun:test";
import type { AgentTokenUsageModelShare } from "#src/features/agents/agent-token-usage-model";
import { summarizeModelDistribution } from "#src/features/agents/workspace-agent-usage-model";

function makeModelShare(
  overrides: Partial<AgentTokenUsageModelShare> &
    Pick<AgentTokenUsageModelShare, "model" | "effectiveTokens">,
): AgentTokenUsageModelShare {
  return {
    provider: "claude-code",
    totalTokens: overrides.effectiveTokens,
    turns: 1,
    sharePercent: 0,
    ...overrides,
  };
}

describe("summarizeModelDistribution", () => {
  test("returns an empty summary when no models have positive usage", () => {
    expect(summarizeModelDistribution([])).toEqual({
      totalEffectiveTokens: 0,
      totalModelCount: 0,
      slices: [],
      allModels: [],
      otherModels: [],
    });

    expect(
      summarizeModelDistribution([
        makeModelShare({ model: "gpt-5", effectiveTokens: 0, turns: 0 }),
      ]),
    ).toEqual({
      totalEffectiveTokens: 0,
      totalModelCount: 0,
      slices: [],
      allModels: [],
      otherModels: [],
    });
  });

  test("returns a single 100% slice when only one model has usage", () => {
    const result = summarizeModelDistribution([
      makeModelShare({ provider: "codex", model: "gpt-5", effectiveTokens: 4_200, turns: 12 }),
    ]);

    expect(result.totalEffectiveTokens).toBe(4_200);
    expect(result.totalModelCount).toBe(1);
    expect(result.otherModels).toEqual([]);
    expect(result.slices).toEqual([
      {
        key: "codex:gpt-5",
        kind: "model",
        provider: "codex",
        model: "gpt-5",
        effectiveTokens: 4_200,
        turns: 12,
        sharePercent: 100,
        tone: "rank-1",
      },
    ]);
    expect(result.slices).toEqual(result.allModels);
  });

  test("keeps 2 to 4 models without an Other slice, filters zero usage, and sorts deterministically", () => {
    const result = summarizeModelDistribution([
      makeModelShare({ provider: "codex", model: "gpt-5-mini", effectiveTokens: 1_000, turns: 2 }),
      makeModelShare({
        provider: "claude-code",
        model: "claude-opus-4-6",
        effectiveTokens: 5_000,
        turns: 10,
      }),
      makeModelShare({ provider: "codex", model: "gpt-5", effectiveTokens: 2_500, turns: 6 }),
      makeModelShare({
        provider: "gemini",
        model: "gemini-2.5-pro",
        effectiveTokens: 1_500,
        turns: 4,
      }),
      makeModelShare({ provider: "gemini", model: "gemini-unused", effectiveTokens: 0, turns: 0 }),
    ]);

    expect(result.totalEffectiveTokens).toBe(10_000);
    expect(result.totalModelCount).toBe(4);
    expect(result.otherModels).toEqual([]);
    expect(result.slices).toEqual([
      {
        key: "claude-code:claude-opus-4-6",
        kind: "model",
        provider: "claude-code",
        model: "claude-opus-4-6",
        effectiveTokens: 5_000,
        turns: 10,
        sharePercent: 50,
        tone: "rank-1",
      },
      {
        key: "codex:gpt-5",
        kind: "model",
        provider: "codex",
        model: "gpt-5",
        effectiveTokens: 2_500,
        turns: 6,
        sharePercent: 25,
        tone: "rank-2",
      },
      {
        key: "gemini:gemini-2.5-pro",
        kind: "model",
        provider: "gemini",
        model: "gemini-2.5-pro",
        effectiveTokens: 1_500,
        turns: 4,
        sharePercent: 15,
        tone: "rank-3",
      },
      {
        key: "codex:gpt-5-mini",
        kind: "model",
        provider: "codex",
        model: "gpt-5-mini",
        effectiveTokens: 1_000,
        turns: 2,
        sharePercent: 10,
        tone: "rank-4",
      },
    ]);
  });

  test("caps donut at top 4 plus one aggregated Other slice when 5 or more models exist", () => {
    const models = [
      makeModelShare({
        provider: "claude-code",
        model: "claude-opus-4-6",
        effectiveTokens: 4_000,
        turns: 20,
      }),
      makeModelShare({ provider: "codex", model: "gpt-5", effectiveTokens: 2_500, turns: 15 }),
      makeModelShare({
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        effectiveTokens: 1_500,
        turns: 10,
      }),
      makeModelShare({
        provider: "gemini",
        model: "gemini-2.5-pro",
        effectiveTokens: 800,
        turns: 8,
      }),
      makeModelShare({ provider: "codex", model: "o3", effectiveTokens: 500, turns: 5 }),
      makeModelShare({
        provider: "gemini",
        model: "gemini-2.5-flash",
        effectiveTokens: 350,
        turns: 4,
      }),
      makeModelShare({
        provider: "claude-code",
        model: "claude-haiku-4-5",
        effectiveTokens: 250,
        turns: 3,
      }),
      makeModelShare({ provider: "codex", model: "gpt-5-mini", effectiveTokens: 100, turns: 2 }),
    ];

    const result = summarizeModelDistribution(models);

    expect(result.totalEffectiveTokens).toBe(10_000);
    expect(result.totalModelCount).toBe(8);
    expect(result.slices).toHaveLength(5);
    expect(result.slices.slice(0, 4).map((slice) => [slice.key, slice.tone])).toEqual([
      ["claude-code:claude-opus-4-6", "rank-1"],
      ["codex:gpt-5", "rank-2"],
      ["claude-code:claude-sonnet-4-5", "rank-3"],
      ["gemini:gemini-2.5-pro", "rank-4"],
    ]);
    expect(result.slices[4]).toEqual({
      key: "__other__",
      kind: "other",
      otherCount: 4,
      effectiveTokens: 1_200,
      turns: 14,
      sharePercent: 12,
      tone: "other",
    });
    expect(result.otherModels.map((entry) => [entry.key, entry.sharePercent, entry.tone])).toEqual([
      ["codex:o3", 5, "other"],
      ["gemini:gemini-2.5-flash", 3.5, "other"],
      ["claude-code:claude-haiku-4-5", 2.5, "other"],
      ["codex:gpt-5-mini", 1, "other"],
    ]);
    expect(result.allModels).toHaveLength(8);
    expect(result.allModels.map((entry) => entry.tone)).toEqual([
      "rank-1",
      "rank-2",
      "rank-3",
      "rank-4",
      "other",
      "other",
      "other",
      "other",
    ]);
  });

  test("preserves distinct keys when the same model name appears under different providers", () => {
    const result = summarizeModelDistribution([
      makeModelShare({
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        effectiveTokens: 600,
        turns: 3,
      }),
      makeModelShare({
        provider: "openrouter",
        model: "claude-sonnet-4-5",
        effectiveTokens: 400,
        turns: 2,
      }),
    ]);

    expect(result.slices.map((slice) => slice.key)).toEqual([
      "claude-code:claude-sonnet-4-5",
      "openrouter:claude-sonnet-4-5",
    ]);
  });
});
