import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { RUNTIME_PROVIDER, type CodeAgentModelCatalog } from "@lrm/coforge-sdk/internal";

/** Values are DSH's opaque route/model selection tokens, not CoForge provider ids. */
export function dshCatalogFromConfig(
  options: readonly SessionConfigOption[],
): CodeAgentModelCatalog {
  const model = options.find((option) => option.id === "model" || option.category === "model");
  if (model?.type !== "select") throw new Error("DSH model catalog is unavailable");
  const entries = model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  if (!entries.length) throw new Error("DSH model catalog is unavailable");
  const reasoning = options.find((option) => option.id === "reasoning_effort");
  const reasoningEfforts =
    reasoning?.type === "select"
      ? reasoning.options.flatMap((entry) =>
          "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
        )
      : [];
  return {
    provider: RUNTIME_PROVIDER.DSH,
    models: entries.map((entry) => ({
      id: entry.value,
      displayName: entry.name,
      description: entry.description ?? "",
      modelProvider: "",
      reasoningEfforts,
      defaultReasoning:
        reasoning?.type === "select" && reasoningEfforts.includes(reasoning.currentValue)
          ? reasoning.currentValue
          : "",
      recommended: entry.value === model.currentValue,
    })),
  };
}
