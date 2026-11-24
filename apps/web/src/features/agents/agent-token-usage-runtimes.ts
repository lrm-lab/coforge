import type { AgentTokenUsageBucket } from "./agent-token-usage-model";

export type AgentTokenUsageRuntimeSummary = {
  provider: string;
  effectiveTokens: number;
  totalTokens: number;
  newInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  turns: number;
  cacheHitPercent: number | null;
  isCurrent: boolean;
};

export function computeCacheHitPercent(
  newInputTokens: number,
  cacheReadTokens: number,
): number | null {
  const totalInput = newInputTokens + cacheReadTokens;
  return totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 1000) / 10 : null;
}

export function summarizeRuntimesFromBuckets(
  buckets: readonly AgentTokenUsageBucket[],
  currentProvider: string | null,
): AgentTokenUsageRuntimeSummary[] {
  const byProvider = new Map<string, Omit<AgentTokenUsageRuntimeSummary, "cacheHitPercent">>();

  for (const bucket of buckets) {
    for (const model of bucket.models) {
      if (model.turns <= 0 && model.totalTokens <= 0) continue;
      const existing = byProvider.get(model.provider);
      if (existing) {
        existing.effectiveTokens += model.effectiveTokens;
        existing.totalTokens += model.totalTokens;
        existing.newInputTokens += model.newInputTokens;
        existing.cacheReadTokens += model.cacheReadTokens;
        existing.cacheWriteTokens += model.cacheWriteTokens;
        existing.outputTokens += model.outputTokens;
        existing.turns += model.turns;
      } else {
        byProvider.set(model.provider, {
          provider: model.provider,
          effectiveTokens: model.effectiveTokens,
          totalTokens: model.totalTokens,
          newInputTokens: model.newInputTokens,
          cacheReadTokens: model.cacheReadTokens,
          cacheWriteTokens: model.cacheWriteTokens,
          outputTokens: model.outputTokens,
          turns: model.turns,
          isCurrent: currentProvider !== null && model.provider === currentProvider,
        });
      }
    }
  }

  return [...byProvider.values()]
    .map((entry) => ({
      ...entry,
      cacheHitPercent: computeCacheHitPercent(entry.newInputTokens, entry.cacheReadTokens),
    }))
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (b.effectiveTokens !== a.effectiveTokens) return b.effectiveTokens - a.effectiveTokens;
      if (b.turns !== a.turns) return b.turns - a.turns;
      return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
    });
}

export function isolateBucketToProvider(
  bucket: AgentTokenUsageBucket,
  provider: string,
): AgentTokenUsageBucket {
  const models = bucket.models.filter((entry) => entry.provider === provider);
  let newInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let effectiveTokens = 0;
  let totalTokens = 0;
  let turns = 0;

  for (const entry of models) {
    newInputTokens += entry.newInputTokens;
    cacheReadTokens += entry.cacheReadTokens;
    cacheWriteTokens += entry.cacheWriteTokens;
    outputTokens += entry.outputTokens;
    effectiveTokens += entry.effectiveTokens;
    totalTokens += entry.totalTokens;
    turns += entry.turns;
  }

  const onlyThisProvider = models.length > 0 && models.length === bucket.models.length;

  return {
    key: bucket.key,
    dateKey: bucket.dateKey,
    ...(bucket.hour !== undefined ? { hour: bucket.hour } : {}),
    ...(bucket.dayOfWeek !== undefined ? { dayOfWeek: bucket.dayOfWeek } : {}),
    isCurrent: bucket.isCurrent,
    newInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    effectiveTokens,
    totalTokens,
    turns,
    cacheHitPercent: computeCacheHitPercent(newInputTokens, cacheReadTokens),
    models,
    lastContextUsed: onlyThisProvider ? bucket.lastContextUsed : null,
    lastContextWindow: onlyThisProvider ? bucket.lastContextWindow : null,
  };
}

export function resolveDefaultUsageProvider(
  reportRuntimes: readonly AgentTokenUsageRuntimeSummary[],
  currentProvider: string | null,
): string | null {
  if (currentProvider && reportRuntimes.some((rt) => rt.provider === currentProvider)) {
    return currentProvider;
  }
  if (reportRuntimes.length === 1) {
    return reportRuntimes[0]!.provider;
  }
  return null;
}
