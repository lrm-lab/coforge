import { resolveTimeZone } from "#src/lib/dates";
import {
  computeCacheHitPercent,
  isolateBucketToProvider,
  resolveDefaultUsageProvider,
  summarizeRuntimesFromBuckets,
  type AgentTokenUsageRuntimeSummary,
} from "./agent-token-usage-runtimes";

export { computeCacheHitPercent, resolveDefaultUsageProvider, type AgentTokenUsageRuntimeSummary };
export {
  formatCompactTokens,
  formatExactTokens,
  formatUsagePercent,
  heatmapLevel,
} from "./agent-token-usage-format";

export const AGENT_TOKEN_USAGE_RANGES = [1, 7, 14, 30] as const;
export type AgentTokenUsageRange = (typeof AGENT_TOKEN_USAGE_RANGES)[number];

export type AgentTokenUsagePeriodTotals = {
  newInputTokens: number;
  cacheReadTokens: number;
  effectiveTokens: number;
  totalTokens: number;
  turns: number;
};

export type AgentTokenUsageModelEntry = {
  provider: string;
  model: string;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  newInputTokens: number;
  outputTokens: number;
  effectiveTokens: number;
  totalTokens: number;
  turns: number;
};

export type AgentTokenUsageBucket = {
  key: string;
  dateKey: string;
  hour?: number;
  dayOfWeek?: number;
  isCurrent: boolean;
  newInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  effectiveTokens: number;
  totalTokens: number;
  turns: number;
  cacheHitPercent: number | null;
  models: AgentTokenUsageModelEntry[];
  lastContextUsed: number | null;
  lastContextWindow: number | null;
};

export type AgentTokenUsageLiveContext = {
  usedTokens: number;
  windowTokens: number;
  observedAtMs: number;
};

export type AgentTokenUsageReport = {
  range: AgentTokenUsageRange;
  timeZone: string;
  asOf: string;
  trackingStartedAt: string | null;
  todayDateKey: string;
  currentProvider: string | null;
  buckets: AgentTokenUsageBucket[];
  previousPeriod: AgentTokenUsagePeriodTotals;
  previousPeriodByProvider: Record<string, AgentTokenUsagePeriodTotals>;
  liveContextUsage: AgentTokenUsageLiveContext | null;
};

export type AgentTokenUsageTurnSample = Readonly<{
  provider: string;
  model: string;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  recordedAt: Date;
}>;

export type AgentTokenUsageModelShare = AgentTokenUsageModelEntry & {
  cacheHitPercent: number | null;
  sharePercent: number;
};

export type AgentTokenUsageSummary = {
  buckets: AgentTokenUsageBucket[];
  selectedBucket: AgentTokenUsageBucket | null;
  effectiveTokens: number;
  totalTokens: number;
  newInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  turns: number;
  deltaPercent: number | null;
  cacheHitPercent: number | null;
  cacheHitDelta: number | null;
  avgEffectivePerTurn: number | null;
  avgTotalPerTurn: number | null;
  contextUsage: { usedTokens: number; windowTokens: number } | null;
  runtimes: AgentTokenUsageRuntimeSummary[];
  reportRuntimes: AgentTokenUsageRuntimeSummary[];
  models: AgentTokenUsageModelShare[];
  series: {
    newInput: number[];
    cacheRead: number[];
    output: number[];
    effective: number[];
  };
  cacheHitSeries: (number | null)[];
  peakEffective: number;
  peakKey: string | null;
  hasAnyData: boolean;
};

type MutableBucket = Omit<AgentTokenUsageBucket, "models"> & {
  models: Map<string, AgentTokenUsageModelEntry>;
};

export type AgentTokenUsageBucketSlice = Readonly<{
  dateKey: string;
  hour: number | null;
  provider: string;
  model: string;
  turns: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  contextRecordedAt: Date | null;
}>;

export function queryWindowStart(
  range: AgentTokenUsageRange,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): Date {
  const zone = resolveTimeZone(timeZone);
  const nowZdt = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(zone);
  const startDate = nowZdt.toPlainDate().subtract({ days: range * 2 });
  const startZdt = startDate.toZonedDateTime({
    timeZone: zone,
    plainTime: new Temporal.PlainTime(0),
  });
  return new Date(startZdt.epochMilliseconds);
}

type MutableBucketWithContextTime = MutableBucket & {
  lastContextRecordedAtMs: number | null;
};

function emptyBucket(
  key: string,
  dateKey: string,
  isCurrent: boolean,
  extra: { hour?: number; dayOfWeek?: number },
): MutableBucketWithContextTime {
  return {
    key,
    dateKey,
    ...(extra.hour !== undefined ? { hour: extra.hour } : {}),
    ...(extra.dayOfWeek !== undefined ? { dayOfWeek: extra.dayOfWeek } : {}),
    isCurrent,
    newInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    effectiveTokens: 0,
    totalTokens: 0,
    turns: 0,
    cacheHitPercent: null,
    models: new Map(),
    lastContextUsed: null,
    lastContextWindow: null,
    lastContextRecordedAtMs: null,
  };
}

function addSliceToBucket(bucket: MutableBucketWithContextTime, slice: AgentTokenUsageBucketSlice) {
  const newInput = slice.uncachedInputTokens + slice.cacheWriteTokens;
  const cacheRead = slice.cacheReadTokens;
  const output = slice.outputTokens;
  const effective = newInput + output;
  const total = newInput + cacheRead + output;

  bucket.newInputTokens += newInput;
  bucket.cacheReadTokens += cacheRead;
  bucket.cacheWriteTokens += slice.cacheWriteTokens;
  bucket.outputTokens += output;
  bucket.effectiveTokens += effective;
  bucket.totalTokens += total;
  bucket.turns += slice.turns;

  if (
    slice.contextUsedTokens !== null &&
    slice.contextWindowTokens !== null &&
    slice.contextWindowTokens > 0
  ) {
    const sliceTs = slice.contextRecordedAt?.getTime() ?? 0;
    if (bucket.lastContextRecordedAtMs === null || sliceTs >= bucket.lastContextRecordedAtMs) {
      bucket.lastContextUsed = slice.contextUsedTokens;
      bucket.lastContextWindow = slice.contextWindowTokens;
      bucket.lastContextRecordedAtMs = sliceTs;
    }
  }

  const modelKey = `${slice.provider}\u0000${slice.model}`;
  const existing = bucket.models.get(modelKey);
  if (existing) {
    existing.uncachedInputTokens += slice.uncachedInputTokens;
    existing.cacheReadTokens += cacheRead;
    existing.cacheWriteTokens += slice.cacheWriteTokens;
    existing.newInputTokens += newInput;
    existing.outputTokens += output;
    existing.effectiveTokens += effective;
    existing.totalTokens += total;
    existing.turns += slice.turns;
  } else {
    bucket.models.set(modelKey, {
      provider: slice.provider,
      model: slice.model,
      uncachedInputTokens: slice.uncachedInputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: slice.cacheWriteTokens,
      newInputTokens: newInput,
      outputTokens: output,
      effectiveTokens: effective,
      totalTokens: total,
      turns: slice.turns,
    });
  }
}

export function aggregateAgentTokenUsageSlices(input: {
  slices: readonly AgentTokenUsageBucketSlice[];
  range: AgentTokenUsageRange;
  timeZone: string | null | undefined;
  now?: Date;
  trackingStartedAt: Date | null;
  liveContextUsage: AgentTokenUsageLiveContext | null;
  currentProvider?: string | null;
}): AgentTokenUsageReport {
  const zone = resolveTimeZone(input.timeZone);
  const now = input.now ?? new Date();
  const nowZdt = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(zone);
  const today = nowZdt.toPlainDate();
  const todayDateKey = today.toString();

  const bucketsByKey = new Map<string, MutableBucketWithContextTime>();
  const orderedKeys: string[] = [];

  if (input.range === 1) {
    for (let hour = 0; hour < 24; hour++) {
      const key = String(hour).padStart(2, "0");
      orderedKeys.push(key);
      bucketsByKey.set(key, emptyBucket(key, todayDateKey, hour === nowZdt.hour, { hour }));
    }
  } else {
    const startDate = today.subtract({ days: input.range - 1 });
    for (let offset = 0; offset < input.range; offset++) {
      const date = startDate.add({ days: offset });
      const dateKey = date.toString();
      orderedKeys.push(dateKey);
      bucketsByKey.set(
        dateKey,
        emptyBucket(dateKey, dateKey, date.equals(today), { dayOfWeek: date.dayOfWeek }),
      );
    }
  }

  const currentStartDate = input.range === 1 ? today : today.subtract({ days: input.range - 1 });
  const prevStartDate = currentStartDate.subtract({ days: input.range });
  const prevEndDate = currentStartDate.subtract({ days: 1 });

  let prevNewInput = 0;
  let prevCacheRead = 0;
  let prevEffective = 0;
  let prevTotal = 0;
  let prevTurns = 0;
  const previousPeriodByProvider: Record<string, AgentTokenUsagePeriodTotals> = {};

  for (const slice of input.slices) {
    const sliceDate = Temporal.PlainDate.from(slice.dateKey);
    if (
      Temporal.PlainDate.compare(sliceDate, currentStartDate) >= 0 &&
      Temporal.PlainDate.compare(sliceDate, today) <= 0
    ) {
      const key =
        input.range === 1
          ? slice.hour !== null
            ? String(slice.hour).padStart(2, "0")
            : null
          : slice.dateKey;
      const bucket = key !== null ? bucketsByKey.get(key) : undefined;
      if (bucket) addSliceToBucket(bucket, slice);
    } else if (
      Temporal.PlainDate.compare(sliceDate, prevStartDate) >= 0 &&
      Temporal.PlainDate.compare(sliceDate, prevEndDate) <= 0
    ) {
      const newInput = slice.uncachedInputTokens + slice.cacheWriteTokens;
      const cacheRead = slice.cacheReadTokens;
      const effective = newInput + slice.outputTokens;
      const total = effective + cacheRead;
      prevNewInput += newInput;
      prevCacheRead += cacheRead;
      prevEffective += effective;
      prevTotal += total;
      prevTurns += slice.turns;

      const byProvider = previousPeriodByProvider[slice.provider];
      if (byProvider) {
        byProvider.newInputTokens += newInput;
        byProvider.cacheReadTokens += cacheRead;
        byProvider.effectiveTokens += effective;
        byProvider.totalTokens += total;
        byProvider.turns += slice.turns;
      } else {
        previousPeriodByProvider[slice.provider] = {
          newInputTokens: newInput,
          cacheReadTokens: cacheRead,
          effectiveTokens: effective,
          totalTokens: total,
          turns: slice.turns,
        };
      }
    }
  }

  const buckets: AgentTokenUsageBucket[] = orderedKeys.map((key) => {
    const { lastContextRecordedAtMs: _ts, ...bucket } = bucketsByKey.get(key)!;
    return {
      ...bucket,
      cacheHitPercent: computeCacheHitPercent(bucket.newInputTokens, bucket.cacheReadTokens),
      models: [...bucket.models.values()].sort((a, b) => b.effectiveTokens - a.effectiveTokens),
    };
  });

  return {
    range: input.range,
    timeZone: zone,
    asOf: now.toISOString(),
    trackingStartedAt: input.trackingStartedAt ? input.trackingStartedAt.toISOString() : null,
    todayDateKey,
    currentProvider: input.currentProvider ?? null,
    buckets,
    previousPeriod: {
      newInputTokens: prevNewInput,
      cacheReadTokens: prevCacheRead,
      effectiveTokens: prevEffective,
      totalTokens: prevTotal,
      turns: prevTurns,
    },
    previousPeriodByProvider,
    liveContextUsage: input.liveContextUsage,
  };
}

export function aggregateAgentTokenUsage(input: {
  turns: readonly AgentTokenUsageTurnSample[];
  range: AgentTokenUsageRange;
  timeZone: string | null | undefined;
  now?: Date;
  trackingStartedAt: Date | null;
  liveContextUsage: AgentTokenUsageLiveContext | null;
  currentProvider?: string | null;
}): AgentTokenUsageReport {
  const zone = resolveTimeZone(input.timeZone);
  const slices: AgentTokenUsageBucketSlice[] = input.turns.map((turn) => {
    const turnZdt = Temporal.Instant.fromEpochMilliseconds(
      turn.recordedAt.getTime(),
    ).toZonedDateTimeISO(zone);
    return {
      dateKey: turnZdt.toPlainDate().toString(),
      hour: input.range === 1 ? turnZdt.hour : null,
      provider: turn.provider,
      model: turn.model,
      turns: 1,
      uncachedInputTokens: turn.uncachedInputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheWriteTokens: turn.cacheWriteTokens,
      outputTokens: turn.outputTokens,
      contextUsedTokens: turn.contextUsedTokens,
      contextWindowTokens: turn.contextWindowTokens,
      contextRecordedAt: turn.recordedAt,
    };
  });
  return aggregateAgentTokenUsageSlices({
    slices,
    range: input.range,
    timeZone: zone,
    now: input.now,
    trackingStartedAt: input.trackingStartedAt,
    liveContextUsage: input.liveContextUsage,
    currentProvider: input.currentProvider,
  });
}

export function summarizeAgentTokenUsage(
  report: AgentTokenUsageReport,
  selectedKey: string | null,
  selectedProvider: string | null = null,
): AgentTokenUsageSummary {
  const reportRuntimes = summarizeRuntimesFromBuckets(report.buckets, report.currentProvider);
  const buckets =
    selectedProvider !== null
      ? report.buckets.map((bucket) => isolateBucketToProvider(bucket, selectedProvider))
      : report.buckets;

  const selectedBucket =
    selectedKey !== null ? (buckets.find((b) => b.key === selectedKey) ?? null) : null;
  const activeBuckets = selectedBucket ? [selectedBucket] : buckets;

  let newInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let fallbackContext: { usedTokens: number; windowTokens: number } | null = null;
  const modelsMap = new Map<string, AgentTokenUsageModelEntry>();

  for (const bucket of activeBuckets) {
    newInputTokens += bucket.newInputTokens;
    cacheReadTokens += bucket.cacheReadTokens;
    cacheWriteTokens += bucket.cacheWriteTokens;
    outputTokens += bucket.outputTokens;
    turns += bucket.turns;
    if (bucket.lastContextUsed !== null && bucket.lastContextWindow !== null) {
      fallbackContext = {
        usedTokens: bucket.lastContextUsed,
        windowTokens: bucket.lastContextWindow,
      };
    }
    for (const model of bucket.models) {
      const modelKey = `${model.provider}\u0000${model.model}`;
      const existing = modelsMap.get(modelKey);
      if (existing) {
        existing.uncachedInputTokens += model.uncachedInputTokens;
        existing.cacheReadTokens += model.cacheReadTokens;
        existing.cacheWriteTokens += model.cacheWriteTokens;
        existing.newInputTokens += model.newInputTokens;
        existing.outputTokens += model.outputTokens;
        existing.effectiveTokens += model.effectiveTokens;
        existing.totalTokens += model.totalTokens;
        existing.turns += model.turns;
      } else {
        modelsMap.set(modelKey, { ...model });
      }
    }
  }

  const runtimes = summarizeRuntimesFromBuckets(activeBuckets, report.currentProvider);
  const effectiveTokens = newInputTokens + outputTokens;
  const totalTokens = newInputTokens + cacheReadTokens + outputTokens;
  const multiRuntimeActive = selectedProvider === null && runtimes.length > 1;
  const cacheHitPercent = multiRuntimeActive
    ? null
    : computeCacheHitPercent(newInputTokens, cacheReadTokens);

  let trackingCoversWindow = !selectedBucket;
  if (trackingCoversWindow && report.trackingStartedAt && buckets[0]) {
    const startedDate = Temporal.Instant.fromEpochMilliseconds(Date.parse(report.trackingStartedAt))
      .toZonedDateTimeISO(report.timeZone)
      .toPlainDate();
    const previousWindowStart = Temporal.PlainDate.from(buckets[0].dateKey).subtract({
      days: report.range,
    });
    if (Temporal.PlainDate.compare(startedDate, previousWindowStart) > 0) {
      trackingCoversWindow = false;
    }
  }

  const previousTotals =
    selectedProvider !== null
      ? report.previousPeriodByProvider[selectedProvider]
      : report.previousPeriod;
  const previousEffective = previousTotals?.effectiveTokens ?? 0;

  let deltaPercent: number | null = null;
  if (trackingCoversWindow && previousEffective > 0) {
    const rawDelta = Math.round(((effectiveTokens - previousEffective) / previousEffective) * 100);
    deltaPercent = rawDelta === 0 ? 0 : rawDelta;
  }

  const previousCacheHitPercent = previousTotals
    ? computeCacheHitPercent(previousTotals.newInputTokens, previousTotals.cacheReadTokens)
    : null;
  let cacheHitDelta: number | null = null;
  if (
    trackingCoversWindow &&
    !multiRuntimeActive &&
    cacheHitPercent !== null &&
    previousCacheHitPercent !== null
  ) {
    const rawHitDelta = Math.round((cacheHitPercent - previousCacheHitPercent) * 10) / 10;
    cacheHitDelta = rawHitDelta === 0 ? 0 : rawHitDelta;
  }

  const models: AgentTokenUsageModelShare[] = [...modelsMap.values()]
    .sort((a, b) => {
      if (b.effectiveTokens !== a.effectiveTokens) return b.effectiveTokens - a.effectiveTokens;
      if (b.turns !== a.turns) return b.turns - a.turns;
      return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
    })
    .map((entry) => ({
      ...entry,
      cacheHitPercent: computeCacheHitPercent(entry.newInputTokens, entry.cacheReadTokens),
      sharePercent:
        effectiveTokens > 0 ? Math.round((entry.effectiveTokens / effectiveTokens) * 1000) / 10 : 0,
    }));

  const series = {
    newInput: buckets.map((b) => b.newInputTokens),
    cacheRead: buckets.map((b) => b.cacheReadTokens),
    output: buckets.map((b) => b.outputTokens),
    effective: buckets.map((b) => b.effectiveTokens),
  };

  const multiRuntimeReport = selectedProvider === null && reportRuntimes.length > 1;
  const cacheHitSeries = multiRuntimeReport
    ? buckets.map(() => null)
    : buckets.map((b) => b.cacheHitPercent);

  let peakEffective = 0;
  let peakKey: string | null = null;
  for (const bucket of buckets) {
    if (bucket.effectiveTokens > peakEffective) {
      peakEffective = bucket.effectiveTokens;
      peakKey = bucket.key;
    }
  }

  const contextUsage =
    selectedBucket && !selectedBucket.isCurrent
      ? fallbackContext
      : report.liveContextUsage
        ? {
            usedTokens: report.liveContextUsage.usedTokens,
            windowTokens: report.liveContextUsage.windowTokens,
          }
        : fallbackContext;

  const hasAnyData =
    report.trackingStartedAt !== null ||
    report.buckets.some((bucket) => bucket.turns > 0 || bucket.totalTokens > 0);

  return {
    buckets,
    selectedBucket,
    effectiveTokens,
    totalTokens,
    newInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    turns,
    deltaPercent,
    cacheHitPercent,
    cacheHitDelta,
    avgEffectivePerTurn: turns > 0 ? Math.round(effectiveTokens / turns) : null,
    avgTotalPerTurn: turns > 0 ? Math.round(totalTokens / turns) : null,
    contextUsage,
    runtimes,
    reportRuntimes,
    models,
    series,
    cacheHitSeries,
    peakEffective,
    peakKey,
    hasAnyData,
  };
}
