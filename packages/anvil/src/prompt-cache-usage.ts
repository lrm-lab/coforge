export type PromptCacheUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  cacheHitRatio: number;
}>;

export type PromptCacheLogFields = Readonly<{
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
  cache_hit_ratio: number;
}>;

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function buildPromptCacheUsage(input: {
  inputTokens: unknown;
  cachedInputTokens?: unknown;
  cacheWriteInputTokens?: unknown;
  outputTokens?: unknown;
  reasoningOutputTokens?: unknown;
}): PromptCacheUsage | undefined {
  const inputTokens = nonNegative(input.inputTokens);
  if (inputTokens <= 0) return undefined;
  const cachedInputTokens = Math.min(nonNegative(input.cachedInputTokens), inputTokens);
  const cacheWriteInputTokens = Math.min(
    nonNegative(input.cacheWriteInputTokens),
    Math.max(0, inputTokens - cachedInputTokens),
  );
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens);
  const outputTokens = nonNegative(input.outputTokens);
  const reasoningOutputTokens =
    typeof input.reasoningOutputTokens === "number" &&
    Number.isFinite(input.reasoningOutputTokens) &&
    input.reasoningOutputTokens >= 0
      ? input.reasoningOutputTokens
      : undefined;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    uncachedInputTokens,
    outputTokens,
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    cacheHitRatio: Math.round((cachedInputTokens / inputTokens) * 10_000) / 10_000,
  };
}

export function promptCacheLogFields(usage: PromptCacheUsage): PromptCacheLogFields {
  return {
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_input_tokens: usage.cacheWriteInputTokens,
    uncached_input_tokens: usage.uncachedInputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.reasoningOutputTokens !== undefined
      ? { reasoning_output_tokens: usage.reasoningOutputTokens }
      : {}),
    cache_hit_ratio: usage.cacheHitRatio,
  };
}
