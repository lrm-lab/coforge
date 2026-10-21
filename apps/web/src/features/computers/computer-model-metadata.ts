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
    const supportsFastMode = Reflect.get(candidate, "supportsFastMode");
    if (
      typeof id !== "string" ||
      typeof displayName !== "string" ||
      typeof description !== "string" ||
      typeof modelProvider !== "string" ||
      !Array.isArray(reasoningEfforts) ||
      !reasoningEfforts.every((effort) => typeof effort === "string") ||
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
      // A non-boolean value is dropped on its own; it does not reject the whole catalog.
      ...(typeof supportsFastMode === "boolean" ? { supportsFastMode } : {}),
    });
  }
  return models;
}
