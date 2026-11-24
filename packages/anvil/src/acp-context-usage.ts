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

function firstNonNegativeInt(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = nonNegativeInt(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function acpUsageRecordTokenUsage(
  usage: Readonly<Record<string, unknown>> | undefined,
): AgentTurnTokenUsage | undefined {
  if (!usage) return undefined;
  const rawOutput = firstNonNegativeInt(usage, ["outputTokens", "output_tokens"]);
  const reasoning = firstNonNegativeInt(usage, [
    "thoughtTokens",
    "thought_tokens",
    "reasoningOutputTokens",
    "reasoning_output_tokens",
    "reasoningTokens",
    "reasoning_tokens",
  ]);
  const rawInput = firstNonNegativeInt(usage, ["inputTokens", "input_tokens"]);
  const rawCacheRead = firstNonNegativeInt(usage, [
    "cachedReadTokens",
    "cached_read_tokens",
    "cacheReadTokens",
    "cache_read_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
  ]);
  const rawCacheWrite = firstNonNegativeInt(usage, [
    "cachedWriteTokens",
    "cached_write_tokens",
    "cacheWriteTokens",
    "cache_write_tokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
  ]);
  const totalTokens = firstNonNegativeInt(usage, ["totalTokens", "total_tokens"]);

  if (
    rawInput === undefined &&
    rawOutput === undefined &&
    rawCacheRead === undefined &&
    rawCacheWrite === undefined &&
    reasoning === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  const baseOutput = rawOutput ?? 0;
  const cacheReadCandidate = rawCacheRead ?? 0;
  const cacheWriteCandidate = rawCacheWrite ?? 0;
  const cacheSum = cacheReadCandidate + cacheWriteCandidate;

  let uncachedInputTokens: number;
  let cacheReadTokens: number;
  let cacheWriteTokens: number;

  if (rawInput !== undefined) {
    const inputExcludesCache =
      cacheSum > 0 &&
      (rawInput < cacheSum ||
        (totalTokens !== undefined && totalTokens >= rawInput + cacheSum + baseOutput));
    if (inputExcludesCache) {
      uncachedInputTokens = rawInput;
      cacheReadTokens = cacheReadCandidate;
      cacheWriteTokens = cacheWriteCandidate;
    } else {
      cacheReadTokens = Math.min(cacheReadCandidate, rawInput);
      cacheWriteTokens = Math.min(cacheWriteCandidate, Math.max(0, rawInput - cacheReadTokens));
      uncachedInputTokens = Math.max(0, rawInput - cacheReadTokens - cacheWriteTokens);
    }
  } else if (totalTokens !== undefined) {
    const inferredWithSeparateThought = Math.max(0, totalTokens - baseOutput - (reasoning ?? 0));
    const totalInput =
      inferredWithSeparateThought < cacheSum && totalTokens >= cacheSum + baseOutput
        ? Math.max(0, totalTokens - baseOutput)
        : inferredWithSeparateThought;
    cacheReadTokens = Math.min(cacheReadCandidate, totalInput);
    cacheWriteTokens = Math.min(cacheWriteCandidate, Math.max(0, totalInput - cacheReadTokens));
    uncachedInputTokens = Math.max(0, totalInput - cacheReadTokens - cacheWriteTokens);
  } else {
    uncachedInputTokens = 0;
    cacheReadTokens = cacheReadCandidate;
    cacheWriteTokens = cacheWriteCandidate;
  }

  const totalInput = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const separateThought =
    reasoning !== undefined &&
    reasoning > 0 &&
    (reasoning > baseOutput ||
      (totalTokens !== undefined && totalInput + baseOutput + reasoning === totalTokens));
  const outputTokens = separateThought ? baseOutput + reasoning : baseOutput;

  if (totalInput + outputTokens <= 0) return undefined;
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

export function acpPromptTokenUsage(response: unknown): AgentTurnTokenUsage | undefined {
  const record = asRecord(response);
  if (!record) return undefined;
  return (
    acpUsageRecordTokenUsage(asRecord(record.usage)) ??
    acpUsageRecordTokenUsage(asRecord(asRecord(record._meta)?.usage))
  );
}

export function acpUpdateTokenUsage(
  update: Readonly<Record<string, unknown>>,
): AgentTurnTokenUsage | undefined {
  return (
    acpUsageRecordTokenUsage(asRecord(update.usage)) ??
    acpUsageRecordTokenUsage(asRecord(asRecord(update._meta)?.usage)) ??
    acpUsageRecordTokenUsage(update)
  );
}
