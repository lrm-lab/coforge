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

export function hasExpectedThreadConfig(
  params: Record<string, unknown> | undefined,
  expectedServiceTier: "fast" | "default" | null,
): boolean {
  const config = params?.config as Record<string, unknown> | undefined;
  if (params?.model !== "gpt-5.6-sol" || config?.model_reasoning_effort !== "high") return false;
  return params?.serviceTier === expectedServiceTier;
}

/** The tier codex echoes for a request, mirroring its real reply (measured on 0.163.0). */
export function appliedServiceTier(requested: unknown): string | null {
  if (requested === "fast" || requested === "priority") return "priority";
  return requested === undefined || requested === "default" ? "default" : null;
}
