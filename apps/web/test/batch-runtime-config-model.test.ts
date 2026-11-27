import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { CODEX_COMPATIBLE_MODEL_PROVIDER } from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import {
  buildInitialBatchRuntimeSelection,
  hasHeterogeneousBatchRuntime,
  parseBatchEnvPatch,
  planBatchRuntimePreview,
  type BatchRuntimePreviewAgent,
} from "#src/features/agents/batch-runtime-config-model";

function previewAgent(
  overrides: Partial<BatchRuntimePreviewAgent> & { id: string },
): BatchRuntimePreviewAgent {
  const { id, ...rest } = overrides;
  return {
    id,
    displayName: `Agent ${id}`,
    ownedByCurrentUser: true,
    stopped: false,
    hasApiKey: false,
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    runtimeConfig: {
      model: "claude-sonnet-4-5",
      modelProvider: "",
      reasoning: "high",
      fastMode: false,
    },
    ...rest,
  };
}

describe("batch-runtime-config-model", () => {
  test("initial selection picks shared runtime/model when all editable Agents match, otherwise first valid Agent", () => {
    const shared = buildInitialBatchRuntimeSelection([
      previewAgent({ id: "a1" }),
      previewAgent({ id: "a2" }),
    ]);
    expect(shared).toEqual({
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      modelProvider: "",
      model: "claude-sonnet-4-5",
      reasoning: "high",
      fastMode: false,
    });

    const mixed = buildInitialBatchRuntimeSelection([
      previewAgent({ id: "a1", ownedByCurrentUser: false, provider: RUNTIME_PROVIDER.CODEX }),
      previewAgent({
        id: "a2",
        provider: RUNTIME_PROVIDER.CODEX,
        runtimeConfig: { model: "gpt-5.3-codex", modelProvider: "", reasoning: "medium" },
      }),
      previewAgent({ id: "a3", provider: RUNTIME_PROVIDER.CLAUDE_CODE }),
    ]);
    expect(mixed.provider).toBe(RUNTIME_PROVIDER.CODEX);
    expect(mixed.model).toBe("");
  });

  test("parseBatchEnvPatch detects overlapping keys between set and remove", () => {
    const parsed = parseBatchEnvPatch(
      [
        { key: " HTTP_PROXY ", value: "http://127.0.0.1:7890" },
        { key: "", value: "ignored" },
      ],
      ["HTTP_PROXY", "DEBUG_TRACE"],
    );
    expect(parsed.conflictKeys).toEqual(["HTTP_PROXY"]);
    expect(parsed.set).toEqual({ HTTP_PROXY: "http://127.0.0.1:7890" });
    expect(parsed.remove).toEqual(["HTTP_PROXY", "DEBUG_TRACE"]);
  });

  test("plans per-Agent outcomes accurately for keep-runtime, same-provider hot push, cross-provider restart, stopped, and offline", () => {
    const agents = [
      previewAgent({ id: "a1" }),
      previewAgent({
        id: "a2",
        provider: RUNTIME_PROVIDER.CODEX,
        runtimeConfig: { model: "gpt-5.3-codex", modelProvider: "", reasoning: "high" },
      }),
      previewAgent({ id: "a3", stopped: true }),
      previewAgent({
        id: "a4",
        runtimeConfig: {
          model: "claude-opus-4-5",
          modelProvider: "",
          reasoning: "high",
          fastMode: true,
        },
      }),
      previewAgent({ id: "a5", ownedByCurrentUser: false }),
    ];

    const plan = planBatchRuntimePreview({
      agents,
      computerOnline: true,
      keepRuntime: false,
      selection: {
        provider: RUNTIME_PROVIDER.CLAUDE_CODE,
        modelProvider: "",
        model: "claude-opus-4-5",
        reasoning: "high",
        fastMode: true,
      },
      apiKey: "",
      envPatch: { set: { HTTP_PROXY: "http://127.0.0.1:7890" }, remove: ["DEBUG_TRACE"] },
      envKeysByAgent: {
        a1: ["DEBUG_TRACE", "NODE_ENV"],
        a2: ["NODE_ENV"],
        a3: [],
        a4: ["HTTP_PROXY"],
      },
    });

    expect(plan.excludedCount).toBe(1);
    expect(plan.rows.map((r) => [r.agent.id, r.plan])).toEqual([
      ["a1", "when-idle"],
      ["a2", "restart"],
      ["a3", "deferred"],
      ["a4", "when-idle"],
    ]);
    expect(plan.willRestartCount).toBe(1);
    expect(plan.whenIdleCount).toBe(2);
    expect(plan.deferredCount).toBe(1);
    expect(plan.changedCount).toBe(4);
    expect(plan.rows[0]?.envSummary).toEqual({
      added: ["HTTP_PROXY"],
      updated: [],
      removed: ["DEBUG_TRACE"],
    });
    expect(plan.rows[3]?.envSummary).toEqual({
      added: [],
      updated: ["HTTP_PROXY"],
      removed: [],
    });

    const keepPlan = planBatchRuntimePreview({
      agents: [previewAgent({ id: "a1" }), previewAgent({ id: "a2" })],
      computerOnline: true,
      keepRuntime: true,
      selection: undefined,
      apiKey: "",
      envPatch: { set: {}, remove: ["DEBUG_TRACE"] },
      envKeysByAgent: { a1: ["DEBUG_TRACE"], a2: ["NODE_ENV"] },
    });
    expect(keepPlan.rows.map((r) => [r.agent.id, r.plan])).toEqual([
      ["a1", "when-idle"],
      ["a2", "unchanged"],
    ]);
    expect(keepPlan.changedCount).toBe(1);
  });

  test("hasHeterogeneousBatchRuntime detects when selected owned Agents differ from initial selection", () => {
    const identical = [previewAgent({ id: "a1" }), previewAgent({ id: "a2" })];
    expect(
      hasHeterogeneousBatchRuntime(identical, buildInitialBatchRuntimeSelection(identical)),
    ).toBe(false);

    const mixed = [
      previewAgent({ id: "a1" }),
      previewAgent({ id: "a2", provider: RUNTIME_PROVIDER.CODEX }),
    ];
    expect(hasHeterogeneousBatchRuntime(mixed, buildInitialBatchRuntimeSelection(mixed))).toBe(
      true,
    );
  });

  test("preserves codex-compatible baseUrl and key across same-origin batch edits, and requires key on origin change", () => {
    const codexAgent = (id: string, baseUrl: string) =>
      previewAgent({
        id,
        hasApiKey: true,
        provider: RUNTIME_PROVIDER.CODEX,
        runtimeConfig: {
          model: "gpt-5.4",
          modelProvider: CODEX_COMPATIBLE_MODEL_PROVIDER,
          reasoning: "medium",
          fastMode: false,
          provider: {
            kind: "codex-compatible",
            baseUrl,
            hasKey: true,
          },
        },
      });
    const pair = [
      codexAgent("c1", "https://relay.example.com/v1"),
      codexAgent("c2", "https://relay.example.com/v1"),
    ];
    const initial = buildInitialBatchRuntimeSelection(pair);
    expect(initial).toEqual({
      provider: RUNTIME_PROVIDER.CODEX,
      modelProvider: CODEX_COMPATIBLE_MODEL_PROVIDER,
      model: "gpt-5.4",
      reasoning: "medium",
      fastMode: false,
      baseUrl: "https://relay.example.com/v1",
      hasCodexCompatibleKey: true,
    });
    expect(hasHeterogeneousBatchRuntime(pair, initial)).toBe(false);

    const sameOriginPlan = planBatchRuntimePreview({
      agents: pair,
      computerOnline: true,
      keepRuntime: false,
      selection: { ...initial, baseUrl: "https://relay.example.com/v2" },
      apiKey: "",
      envPatch: { set: {}, remove: [] },
      envKeysByAgent: {},
    });
    expect(sameOriginPlan.needsApiKey).toBe(true);
    expect(sameOriginPlan.missingApiKey).toBe(false);
    expect(sameOriginPlan.changedCount).toBe(2);
    expect(sameOriginPlan.willRestartCount).toBe(2);
    expect(sameOriginPlan.rows.every((row) => row.providerChanged)).toBe(true);

    const modelOnlyPlan = planBatchRuntimePreview({
      agents: pair,
      computerOnline: true,
      keepRuntime: false,
      selection: { ...initial, model: "gpt-5.4-mini" },
      apiKey: "",
      envPatch: { set: {}, remove: [] },
      envKeysByAgent: {},
    });
    expect(modelOnlyPlan.whenIdleCount).toBe(2);
    expect(modelOnlyPlan.willRestartCount).toBe(0);

    const changedOriginPlan = planBatchRuntimePreview({
      agents: pair,
      computerOnline: true,
      keepRuntime: false,
      selection: { ...initial, baseUrl: "https://other.example.com/v1" },
      apiKey: "",
      envPatch: { set: {}, remove: [] },
      envKeysByAgent: {},
    });
    expect(changedOriginPlan.needsApiKey).toBe(true);
    expect(changedOriginPlan.missingApiKey).toBe(true);
  });
});
