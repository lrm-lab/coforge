/**
 * The `model/list` answer the fake Codex app-server returns, shaped after codex-cli 0.163.0's own
 * reply: the Fast tier's service-tier `id` is "priority", its speed-tier id is "fast" (the value
 * `thread/start` takes), and `isDefault` marks the recommended model.
 */
export const CODEX_MODEL_LIST = {
  data: [
    {
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Primary coding model",
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
      ],
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed" }],
      additionalSpeedTiers: ["fast"],
    },
  ],
  nextCursor: null,
};

/**
 * What `thread/start` must report for the fixture's single model: the selected model and effort,
 * and — because the Fast tier is opt-in per launch — the requested service tier exactly, so
 * neither a dropped nor a stray `serviceTier` passes.
 */
export function hasExpectedThreadConfig(
  params: Record<string, unknown> | undefined,
  expectsFastMode: boolean,
): boolean {
  const config = params?.config as Record<string, unknown> | undefined;
  if (params?.model !== "gpt-5.6-sol" || config?.model_reasoning_effort !== "high") return false;
  return expectsFastMode ? params?.serviceTier === "fast" : !("serviceTier" in (params ?? {}));
}

/** The tier codex echoes for a request, mirroring its real reply (measured on 0.163.0). */
export function appliedServiceTier(requested: unknown): string | null {
  if (requested === "fast" || requested === "priority") return "priority";
  return requested === undefined ? "default" : null;
}

/**
 * Models that differ only in how they report speed tiers, served by the `catalog-speed-tiers`
 * mode of `codex-app-server.ts`: a service tier, a speed tier alone, neither, a tier that is not
 * Fast, and an older Codex that reports no tier field at all.
 */
export const CODEX_SPEED_TIER_MODEL_LIST = {
  data: [
    {
      model: "tier-service",
      displayName: "Tier service",
      serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed" }],
    },
    { model: "tier-speed", additionalSpeedTiers: ["fast"], serviceTiers: [] },
    { model: "no-fast", serviceTiers: [], additionalSpeedTiers: [] },
    { model: "other-tier", serviceTiers: [{ id: "flex", name: "Flex" }] },
    { model: "legacy" },
  ],
  nextCursor: null,
};
