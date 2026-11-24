import type { AgentRuntimeEvent, AgentTurnTokenUsage } from "@coforge/agent";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import { asRecord } from "#src/json-record";

export function acpContextUsage(update: Readonly<Record<string, unknown>>): AgentRuntimeEvent[] {
  const { used, size } = update;
  return typeof used === "number" &&
    typeof size === "number" &&
    Number.isFinite(used) &&
    Number.isFinite(size) &&
    used >= 0 &&
    size > 0
    ? [{ type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE, usedTokens: used, windowTokens: size }]
    : [];
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function acpPromptTokenUsage(response: unknown): AgentTurnTokenUsage | undefined {
  const usage = asRecord(asRecord(response)?.usage);
  if (!usage) return undefined;
  const outputTokens = nonNegativeInt(usage.outputTokens) ?? 0;
  const reasoning = nonNegativeInt(usage.thoughtTokens);
  const rawInput = nonNegativeInt(usage.inputTokens);
  const totalTokens = nonNegativeInt(usage.totalTokens);
  const totalInput =
    rawInput !== undefined
      ? rawInput
      : totalTokens !== undefined
        ? Math.max(0, totalTokens - outputTokens - (reasoning ?? 0))
        : 0;
  const cacheReadTokens = Math.min(nonNegativeInt(usage.cachedReadTokens) ?? 0, totalInput);
  const cacheWriteTokens = Math.min(
    nonNegativeInt(usage.cachedWriteTokens) ?? 0,
    Math.max(0, totalInput - cacheReadTokens),
  );
  const uncachedInputTokens = Math.max(0, totalInput - cacheReadTokens - cacheWriteTokens);
  if (uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens <= 0)
    return undefined;
  return {
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    ...(reasoning !== undefined && reasoning <= outputTokens
      ? { reasoningOutputTokens: reasoning }
      : {}),
  };
}
