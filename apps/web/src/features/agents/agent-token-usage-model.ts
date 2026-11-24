import { resolveTimeZone } from "#src/lib/dates";

export const AGENT_TOKEN_USAGE_RANGES = [1, 7, 14, 30] as const;
export type AgentTokenUsageRange = (typeof AGENT_TOKEN_USAGE_RANGES)[number];

export type AgentTokenUsageModelEntry = {
  provider: string;
  model: string;
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
  outputTokens: number;
  effectiveTokens: number;
  totalTokens: number;
  turns: number;
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
  buckets: AgentTokenUsageBucket[];
  previousPeriod: {
    effectiveTokens: number;
    totalTokens: number;
    turns: number;
  };
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
  sharePercent: number;
};

export type AgentTokenUsageSummary = {
  selectedBucket: AgentTokenUsageBucket | null;
  effectiveTokens: number;
  totalTokens: number;
  newInputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turns: number;
  deltaPercent: number | null;
  cacheHitPercent: number | null;
  shares: {
    newInputPercent: number;
    cacheReadPercent: number;
    outputPercent: number;
  };
  avgEffectivePerTurn: number | null;
  avgTotalPerTurn: number | null;
  contextUsage: { usedTokens: number; windowTokens: number } | null;
  models: AgentTokenUsageModelShare[];
  series: {
    newInput: number[];
    cacheRead: number[];
    output: number[];
    effective: number[];
  };
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
    outputTokens: 0,
    effectiveTokens: 0,
    totalTokens: 0,
    turns: 0,
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
    existing.effectiveTokens += effective;
    existing.totalTokens += total;
    existing.turns += slice.turns;
  } else {
    bucket.models.set(modelKey, {
      provider: slice.provider,
      model: slice.model,
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

  let prevEffective = 0;
  let prevTotal = 0;
  let prevTurns = 0;

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
      prevEffective += newInput + slice.outputTokens;
      prevTotal += newInput + slice.cacheReadTokens + slice.outputTokens;
      prevTurns += slice.turns;
    }
  }

  const buckets: AgentTokenUsageBucket[] = orderedKeys.map((key) => {
    const { lastContextRecordedAtMs: _ts, ...bucket } = bucketsByKey.get(key)!;
    return {
      ...bucket,
      models: [...bucket.models.values()].sort((a, b) => b.effectiveTokens - a.effectiveTokens),
    };
  });

  return {
    range: input.range,
    timeZone: zone,
    asOf: now.toISOString(),
    trackingStartedAt: input.trackingStartedAt ? input.trackingStartedAt.toISOString() : null,
    todayDateKey,
    buckets,
    previousPeriod: {
      effectiveTokens: prevEffective,
      totalTokens: prevTotal,
      turns: prevTurns,
    },
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
  });
}

export function summarizeAgentTokenUsage(
  report: AgentTokenUsageReport,
  selectedKey: string | null,
): AgentTokenUsageSummary {
  const selectedBucket =
    selectedKey !== null ? (report.buckets.find((b) => b.key === selectedKey) ?? null) : null;
  const activeBuckets = selectedBucket ? [selectedBucket] : report.buckets;

  let newInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let fallbackContext: { usedTokens: number; windowTokens: number } | null = null;
  const modelsMap = new Map<string, AgentTokenUsageModelEntry>();

  for (const bucket of activeBuckets) {
    newInputTokens += bucket.newInputTokens;
    cacheReadTokens += bucket.cacheReadTokens;
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
        existing.effectiveTokens += model.effectiveTokens;
        existing.totalTokens += model.totalTokens;
        existing.turns += model.turns;
      } else {
        modelsMap.set(modelKey, { ...model });
      }
    }
  }

  const effectiveTokens = newInputTokens + outputTokens;
  const totalTokens = newInputTokens + cacheReadTokens + outputTokens;
  const totalInput = newInputTokens + cacheReadTokens;
  const cacheHitPercent =
    totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 1000) / 10 : null;

  const shareOf = (part: number) =>
    totalTokens > 0 ? Math.round((part / totalTokens) * 1000) / 10 : 0;

  let deltaPercent: number | null = null;
  if (!selectedBucket && report.previousPeriod.effectiveTokens > 0) {
    let trackingCoversWindow = true;
    if (report.trackingStartedAt && report.buckets[0]) {
      const startedDate = Temporal.Instant.fromEpochMilliseconds(
        Date.parse(report.trackingStartedAt),
      )
        .toZonedDateTimeISO(report.timeZone)
        .toPlainDate();
      const previousWindowStart = Temporal.PlainDate.from(report.buckets[0].dateKey).subtract({
        days: report.range,
      });
      if (Temporal.PlainDate.compare(startedDate, previousWindowStart) > 0)
        trackingCoversWindow = false;
    }
    if (trackingCoversWindow) {
      deltaPercent = Math.round(
        ((effectiveTokens - report.previousPeriod.effectiveTokens) /
          report.previousPeriod.effectiveTokens) *
          100,
      );
    }
  }

  const models: AgentTokenUsageModelShare[] = [...modelsMap.values()]
    .sort((a, b) => b.effectiveTokens - a.effectiveTokens)
    .map((entry) => ({
      ...entry,
      sharePercent:
        effectiveTokens > 0 ? Math.round((entry.effectiveTokens / effectiveTokens) * 1000) / 10 : 0,
    }));

  const series = {
    newInput: report.buckets.map((b) => b.newInputTokens),
    cacheRead: report.buckets.map((b) => b.cacheReadTokens),
    output: report.buckets.map((b) => b.outputTokens),
    effective: report.buckets.map((b) => b.effectiveTokens),
  };

  let peakEffective = 0;
  let peakKey: string | null = null;
  for (const bucket of report.buckets) {
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
    selectedBucket,
    effectiveTokens,
    totalTokens,
    newInputTokens,
    cacheReadTokens,
    outputTokens,
    turns,
    deltaPercent,
    cacheHitPercent,
    shares: {
      newInputPercent: shareOf(newInputTokens),
      cacheReadPercent: shareOf(cacheReadTokens),
      outputPercent: shareOf(outputTokens),
    },
    avgEffectivePerTurn: turns > 0 ? Math.round(effectiveTokens / turns) : null,
    avgTotalPerTurn: turns > 0 ? Math.round(totalTokens / turns) : null,
    contextUsage,
    models,
    series,
    peakEffective,
    peakKey,
    hasAnyData,
  };
}

const numberFormatCache = new Map<string, Intl.NumberFormat>();

function cachedNumberFormat(
  key: string,
  locale: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const existing = numberFormatCache.get(key);
  if (existing) return existing;
  const created = new Intl.NumberFormat(locale, options);
  if (numberFormatCache.size >= 32) numberFormatCache.clear();
  numberFormatCache.set(key, created);
  return created;
}

export function formatCompactTokens(value: number, locale: string): string {
  const safe = Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  if (safe < 10_000) return cachedNumberFormat(`exact:${locale}`, locale).format(safe);
  return cachedNumberFormat(`compact:${locale}`, locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(safe);
}

export function formatExactTokens(value: number, locale: string): string {
  const safe = Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  return cachedNumberFormat(`exact:${locale}`, locale).format(safe);
}

export function formatUsagePercent(value: number, locale: string): string {
  return cachedNumberFormat(`pct:${locale}`, locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value / 100);
}

export function heatmapLevel(value: number, peak: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || peak <= 0) return 0;
  const ratio = value / peak;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}
