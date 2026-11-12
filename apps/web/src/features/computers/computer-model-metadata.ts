import type { CodeAgentModelMetadata } from "@lrm/coforge-sdk/internal";

export function modelMetadata(value: unknown): CodeAgentModelMetadata[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models: CodeAgentModelMetadata[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const id = Reflect.get(candidate, "id");
    const displayName = Reflect.get(candidate, "displayName");
    const description = Reflect.get(candidate, "description");
    const modelProvider = Reflect.get(candidate, "modelProvider");
    const reasoningEfforts = Reflect.get(candidate, "reasoningEfforts");
    const defaultReasoning = Reflect.get(candidate, "defaultReasoning");
    const recommended = Reflect.get(candidate, "recommended");
    // What the provider says about the model's size; absent when it says nothing (task #30).
    const contextWindow = modelSize(Reflect.get(candidate, "contextWindow"));
    const maxOutputTokens = modelSize(Reflect.get(candidate, "maxOutputTokens"));
    if (
      typeof id !== "string" ||
      typeof displayName !== "string" ||
      typeof description !== "string" ||
      typeof modelProvider !== "string" ||
      (reasoningEfforts !== undefined &&
        (!Array.isArray(reasoningEfforts) ||
          !reasoningEfforts.every((effort) => typeof effort === "string"))) ||
      typeof defaultReasoning !== "string" ||
      typeof recommended !== "boolean"
    )
      return undefined;
    models.push({
      id,
      displayName,
      description,
      modelProvider,
      reasoningEfforts,
      defaultReasoning,
      recommended,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
  }
  return models;
}

/** Enough for the largest real window, small enough that a wild number is refused (task #30). */
export const MAX_MODEL_TOKENS = 10_000_000;

/** A stored size, or undefined for a zero, a fraction, anything above what a model could have, or
 * anything else no model has: a catalog written by an older build may carry none of these, and a
 * stale row may carry rubbish. */
export function modelSize(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_MODEL_TOKENS
    ? value
    : undefined;
}
