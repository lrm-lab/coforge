import { resolveTimeZone } from "#src/lib/dates";
import {
  aggregateAgentTokenUsageSlices,
  computeCacheHitPercent,
  summarizeAgentTokenUsage,
  type AgentTokenUsageBucket,
  type AgentTokenUsageBucketSlice,
  type AgentTokenUsageModelEntry,
  type AgentTokenUsageModelShare,
  type AgentTokenUsageRange,
  type AgentTokenUsageReport,
  type AgentTokenUsageSummary,
} from "./agent-token-usage-model";

export type WorkspaceAgentUsageBucketSlice = AgentTokenUsageBucketSlice &
  Readonly<{
    agentId: string;
  }>;

export type WorkspaceAgentUsageAgentMeta = Readonly<{
  id: string;
  displayName: string;
  avatarUrl: string | null;
  model: string;
  ownerId: string;
  ownerDisplayName: string;
  ownerAvatarUrl?: string | null;
  archived?: boolean;
}>;

export type WorkspaceAgentBucketEntry = {
  agentId: string;
  bucketKey: string;
  provider: string;
  model: string;
  turns: number;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  newInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  effectiveTokens: number;
};

export type WorkspaceAgentUsageRow = {
  agentId: string;
  displayName: string;
  avatarUrl: string | null;
  ownerId: string;
  ownerDisplayName: string;
  ownerAvatarUrl: string | null;
  archived: boolean;
  effectiveTokens: number;
  newInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  topModel: string;
  teamSharePercent: number;
};

export type WorkspaceAgentUsageSortKey = "agent" | "tokens" | "turns" | "model" | "owner";

export type WorkspaceAgentUsageSortDirection = "asc" | "desc";

export type WorkspaceAgentUsageSort = Readonly<{
  key: WorkspaceAgentUsageSortKey;
  direction: WorkspaceAgentUsageSortDirection;
}>;

export const DEFAULT_WORKSPACE_AGENT_USAGE_SORT: WorkspaceAgentUsageSort = {
  key: "tokens",
  direction: "desc",
};

export function defaultWorkspaceAgentUsageSortDirection(
  key: WorkspaceAgentUsageSortKey,
): WorkspaceAgentUsageSortDirection {
  return key === "tokens" || key === "turns" ? "desc" : "asc";
}

export function toggleWorkspaceAgentUsageSort(
  current: WorkspaceAgentUsageSort,
  key: WorkspaceAgentUsageSortKey,
): WorkspaceAgentUsageSort {
  if (current.key === key) {
    return {
      key,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }
  return {
    key,
    direction: defaultWorkspaceAgentUsageSortDirection(key),
  };
}

function compareOptionalText(
  aValue: string,
  bValue: string,
  collator: Intl.Collator,
  dir: number,
): number {
  const a = aValue.trim();
  const b = bValue.trim();
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return collator.compare(a, b) * dir;
}

export function sortWorkspaceAgentUsageRows(
  rows: readonly WorkspaceAgentUsageRow[],
  sort: WorkspaceAgentUsageSort = DEFAULT_WORKSPACE_AGENT_USAGE_SORT,
  locale?: string,
): WorkspaceAgentUsageRow[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const dir = sort.direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    let primary = 0;
    switch (sort.key) {
      case "tokens":
        primary = (a.effectiveTokens - b.effectiveTokens) * dir;
        break;
      case "turns":
        primary = (a.turns - b.turns) * dir;
        break;
      case "agent":
        primary = collator.compare(a.displayName, b.displayName) * dir;
        break;
      case "model":
        primary = compareOptionalText(a.topModel, b.topModel, collator, dir);
        break;
      case "owner":
        primary = compareOptionalText(a.ownerDisplayName, b.ownerDisplayName, collator, dir);
        break;
    }
    if (primary !== 0) return primary;

    if (sort.key !== "tokens" && b.effectiveTokens !== a.effectiveTokens) {
      return b.effectiveTokens - a.effectiveTokens;
    }
    if (sort.key !== "turns" && b.turns !== a.turns) {
      return b.turns - a.turns;
    }
    const nameOrder = collator.compare(a.displayName, b.displayName);
    if (nameOrder !== 0) return nameOrder;
    return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
  });
}

export type WorkspaceAgentUsageReport = {
  timeline: AgentTokenUsageReport;
  agents: WorkspaceAgentUsageAgentMeta[];
  agentBuckets: WorkspaceAgentBucketEntry[];
};

export type WorkspaceAgentUsageViewSummary = {
  timelineBuckets: AgentTokenUsageBucket[];
  timelineSummary: AgentTokenUsageSummary;
  teamEffectiveTokens: number;
  visibleEffectiveTokens: number;
  visibleTurns: number;
  visibleActiveAgents: number;
  rows: WorkspaceAgentUsageRow[];
};

export function buildWorkspaceAgentUsageReport(input: {
  agents: readonly WorkspaceAgentUsageAgentMeta[];
  slices: readonly WorkspaceAgentUsageBucketSlice[];
  range: AgentTokenUsageRange;
  timeZone: string | null | undefined;
  now?: Date;
  trackingStartedAt: Date | null;
}): WorkspaceAgentUsageReport {
  const zone = resolveTimeZone(input.timeZone);
  const now = input.now ?? new Date();
  const timeline = aggregateAgentTokenUsageSlices({
    slices: input.slices,
    range: input.range,
    timeZone: zone,
    now,
    trackingStartedAt: input.trackingStartedAt,
    liveContextUsage: null,
  });

  const validBucketKeys = new Set(timeline.buckets.map((b) => b.key));
  const merged = new Map<string, WorkspaceAgentBucketEntry>();

  for (const slice of input.slices) {
    const bucketKey =
      input.range === 1
        ? slice.dateKey === timeline.todayDateKey && slice.hour !== null
          ? String(slice.hour).padStart(2, "0")
          : null
        : slice.dateKey;
    if (!bucketKey || !validBucketKeys.has(bucketKey)) continue;

    const newInputTokens = slice.uncachedInputTokens + slice.cacheWriteTokens;
    const outputTokens = slice.outputTokens;
    const effectiveTokens = newInputTokens + outputTokens;
    const model = slice.model.trim();
    const mapKey = `${slice.agentId}\u0000${bucketKey}\u0000${slice.provider}\u0000${model}`;
    const existing = merged.get(mapKey);
    if (existing) {
      existing.turns += slice.turns;
      existing.uncachedInputTokens += slice.uncachedInputTokens;
      existing.cacheWriteTokens += slice.cacheWriteTokens;
      existing.newInputTokens += newInputTokens;
      existing.outputTokens += outputTokens;
      existing.cacheReadTokens += slice.cacheReadTokens;
      existing.effectiveTokens += effectiveTokens;
    } else {
      merged.set(mapKey, {
        agentId: slice.agentId,
        bucketKey,
        provider: slice.provider,
        model,
        turns: slice.turns,
        uncachedInputTokens: slice.uncachedInputTokens,
        cacheWriteTokens: slice.cacheWriteTokens,
        newInputTokens,
        outputTokens,
        cacheReadTokens: slice.cacheReadTokens,
        effectiveTokens,
      });
    }
  }

  return {
    timeline,
    agents: [...input.agents],
    agentBuckets: [...merged.values()],
  };
}

type MutableAgentTotals = {
  newInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  effectiveTokens: number;
  turns: number;
  models: Map<string, number>;
};

type MutableFilteredBucket = Omit<AgentTokenUsageBucket, "models"> & {
  models: Map<string, AgentTokenUsageModelEntry>;
};

function buildFilteredTimelineBuckets(
  report: WorkspaceAgentUsageReport,
  matchedAgentIds: ReadonlySet<string>,
): AgentTokenUsageBucket[] {
  const byKey = new Map<string, MutableFilteredBucket>();
  const orderedKeys: string[] = [];
  for (const bucket of report.timeline.buckets) {
    orderedKeys.push(bucket.key);
    byKey.set(bucket.key, {
      key: bucket.key,
      dateKey: bucket.dateKey,
      ...(bucket.hour !== undefined ? { hour: bucket.hour } : {}),
      ...(bucket.dayOfWeek !== undefined ? { dayOfWeek: bucket.dayOfWeek } : {}),
      isCurrent: bucket.isCurrent,
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
    });
  }

  for (const entry of report.agentBuckets) {
    if (!matchedAgentIds.has(entry.agentId)) continue;
    const bucket = byKey.get(entry.bucketKey);
    if (!bucket) continue;
    const total = entry.newInputTokens + entry.cacheReadTokens + entry.outputTokens;
    bucket.newInputTokens += entry.newInputTokens;
    bucket.cacheReadTokens += entry.cacheReadTokens;
    bucket.cacheWriteTokens += entry.cacheWriteTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.effectiveTokens += entry.effectiveTokens;
    bucket.totalTokens += total;
    bucket.turns += entry.turns;

    const modelKey = `${entry.provider}\u0000${entry.model}`;
    const existing = bucket.models.get(modelKey);
    if (existing) {
      existing.uncachedInputTokens += entry.uncachedInputTokens;
      existing.cacheReadTokens += entry.cacheReadTokens;
      existing.cacheWriteTokens += entry.cacheWriteTokens;
      existing.newInputTokens += entry.newInputTokens;
      existing.outputTokens += entry.outputTokens;
      existing.effectiveTokens += entry.effectiveTokens;
      existing.totalTokens += total;
      existing.turns += entry.turns;
    } else {
      bucket.models.set(modelKey, {
        provider: entry.provider,
        model: entry.model,
        uncachedInputTokens: entry.uncachedInputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheWriteTokens: entry.cacheWriteTokens,
        newInputTokens: entry.newInputTokens,
        outputTokens: entry.outputTokens,
        effectiveTokens: entry.effectiveTokens,
        totalTokens: total,
        turns: entry.turns,
      });
    }
  }

  return orderedKeys.map((key) => {
    const bucket = byKey.get(key)!;
    return {
      ...bucket,
      cacheHitPercent: computeCacheHitPercent(bucket.newInputTokens, bucket.cacheReadTokens),
      models: [...bucket.models.values()].sort((a, b) => b.effectiveTokens - a.effectiveTokens),
    };
  });
}

export function summarizeWorkspaceAgentUsage(
  report: WorkspaceAgentUsageReport,
  filters: {
    selectedKey: string | null;
    owner: "all" | "mine";
    viewerId: string;
    query: string;
  },
): WorkspaceAgentUsageViewSummary {
  const trimmedQuery = filters.query.trim().toLowerCase();
  const filtersActive = filters.owner === "mine" || Boolean(trimmedQuery);
  const matchedAgentIds = new Set<string>();
  for (const agent of report.agents) {
    if (filters.owner === "mine" && agent.ownerId !== filters.viewerId) continue;
    if (trimmedQuery && !agent.displayName.toLowerCase().includes(trimmedQuery)) continue;
    matchedAgentIds.add(agent.id);
  }

  const timelineBuckets = filtersActive
    ? buildFilteredTimelineBuckets(report, matchedAgentIds)
    : report.timeline.buckets;
  const timelineReport = filtersActive
    ? {
        ...report.timeline,
        buckets: timelineBuckets,
        previousPeriod: { effectiveTokens: 0, totalTokens: 0, turns: 0 },
        previousPeriodByProvider: {},
      }
    : report.timeline;
  const timelineSummary = summarizeAgentTokenUsage(timelineReport, filters.selectedKey);

  const totalsByAgent = new Map<string, MutableAgentTotals>();

  for (const entry of report.agentBuckets) {
    if (filters.selectedKey !== null && entry.bucketKey !== filters.selectedKey) continue;
    let bucket = totalsByAgent.get(entry.agentId);
    if (!bucket) {
      bucket = {
        newInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        effectiveTokens: 0,
        turns: 0,
        models: new Map(),
      };
      totalsByAgent.set(entry.agentId, bucket);
    }
    bucket.newInputTokens += entry.newInputTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.cacheReadTokens += entry.cacheReadTokens;
    bucket.effectiveTokens += entry.effectiveTokens;
    bucket.turns += entry.turns;
    if (entry.model) {
      bucket.models.set(entry.model, (bucket.models.get(entry.model) ?? 0) + entry.effectiveTokens);
    }
  }

  let teamEffectiveTokens = 0;
  const allRows = report.agents.map((agent) => {
    const totals = totalsByAgent.get(agent.id);
    const effectiveTokens = totals?.effectiveTokens ?? 0;
    teamEffectiveTokens += effectiveTokens;

    let topModel = agent.model.trim();
    if (totals && totals.models.size > 0) {
      let best = -1;
      for (const [modelName, tokens] of totals.models) {
        if (tokens > best) {
          best = tokens;
          topModel = modelName;
        }
      }
    }

    return {
      agentId: agent.id,
      displayName: agent.displayName,
      avatarUrl: agent.avatarUrl,
      ownerId: agent.ownerId,
      ownerDisplayName: agent.ownerDisplayName,
      ownerAvatarUrl: agent.ownerAvatarUrl ?? null,
      archived: Boolean(agent.archived),
      effectiveTokens,
      newInputTokens: totals?.newInputTokens ?? 0,
      outputTokens: totals?.outputTokens ?? 0,
      cacheReadTokens: totals?.cacheReadTokens ?? 0,
      turns: totals?.turns ?? 0,
      topModel,
    };
  });

  let visibleEffectiveTokens = 0;
  let visibleTurns = 0;
  let visibleActiveAgents = 0;

  const rows: WorkspaceAgentUsageRow[] = sortWorkspaceAgentUsageRows(
    allRows
      .filter((row) => {
        if (!matchedAgentIds.has(row.agentId)) return false;
        if (row.archived && row.effectiveTokens === 0 && row.turns === 0) return false;
        return true;
      })
      .map((row) => {
        visibleEffectiveTokens += row.effectiveTokens;
        visibleTurns += row.turns;
        if (row.effectiveTokens > 0 || row.turns > 0) visibleActiveAgents += 1;
        return {
          ...row,
          teamSharePercent:
            teamEffectiveTokens > 0
              ? Math.round((row.effectiveTokens / teamEffectiveTokens) * 1000) / 10
              : 0,
        };
      }),
    DEFAULT_WORKSPACE_AGENT_USAGE_SORT,
  );

  return {
    timelineBuckets,
    timelineSummary,
    teamEffectiveTokens,
    visibleEffectiveTokens,
    visibleTurns,
    visibleActiveAgents,
    rows,
  };
}

export const WORKSPACE_MODEL_DONUT_PRIMARY_LIMIT = 4;

export type ModelDistributionSliceTone = "rank-1" | "rank-2" | "rank-3" | "rank-4" | "other";

export type ModelDistributionModelSlice = Readonly<{
  key: string;
  kind: "model";
  provider: string;
  model: string;
  effectiveTokens: number;
  turns: number;
  sharePercent: number;
  tone: ModelDistributionSliceTone;
}>;

export type ModelDistributionOtherSlice = Readonly<{
  key: "__other__";
  kind: "other";
  otherCount: number;
  effectiveTokens: number;
  turns: number;
  sharePercent: number;
  tone: "other";
}>;

export type ModelDistributionSlice = ModelDistributionModelSlice | ModelDistributionOtherSlice;

export type ModelDistributionSummary = Readonly<{
  totalEffectiveTokens: number;
  totalModelCount: number;
  slices: readonly ModelDistributionSlice[];
  allModels: readonly ModelDistributionModelSlice[];
  otherModels: readonly ModelDistributionModelSlice[];
}>;

const PRIMARY_SLICE_TONES: readonly ModelDistributionSliceTone[] = [
  "rank-1",
  "rank-2",
  "rank-3",
  "rank-4",
];

function computeSharePercent(part: number, total: number): number {
  if (total <= 0 || part <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

export function summarizeModelDistribution(
  models: readonly AgentTokenUsageModelShare[],
  primaryLimit: number = WORKSPACE_MODEL_DONUT_PRIMARY_LIMIT,
): ModelDistributionSummary {
  const limit = Math.max(1, Math.min(primaryLimit, PRIMARY_SLICE_TONES.length));
  const sorted = models
    .filter((entry) => entry.effectiveTokens > 0)
    .sort((a, b) => {
      if (b.effectiveTokens !== a.effectiveTokens) return b.effectiveTokens - a.effectiveTokens;
      if (b.turns !== a.turns) return b.turns - a.turns;
      if (a.model !== b.model) return a.model < b.model ? -1 : 1;
      return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
    });

  if (sorted.length === 0) {
    return {
      totalEffectiveTokens: 0,
      totalModelCount: 0,
      slices: [],
      allModels: [],
      otherModels: [],
    };
  }

  const totalEffectiveTokens = sorted.reduce((sum, entry) => sum + entry.effectiveTokens, 0);
  const allModels: ModelDistributionModelSlice[] = sorted.map((entry, index) => ({
    key: `${entry.provider}:${entry.model}`,
    kind: "model",
    provider: entry.provider,
    model: entry.model,
    effectiveTokens: entry.effectiveTokens,
    turns: entry.turns,
    sharePercent: computeSharePercent(entry.effectiveTokens, totalEffectiveTokens),
    tone: index < limit ? PRIMARY_SLICE_TONES[index]! : "other",
  }));

  if (allModels.length <= limit) {
    return {
      totalEffectiveTokens,
      totalModelCount: allModels.length,
      slices: allModels,
      allModels,
      otherModels: [],
    };
  }

  const primary = allModels.slice(0, limit);
  const otherModels = allModels.slice(limit);
  const otherEffectiveTokens = otherModels.reduce((sum, entry) => sum + entry.effectiveTokens, 0);
  const otherTurns = otherModels.reduce((sum, entry) => sum + entry.turns, 0);
  const otherSlice: ModelDistributionOtherSlice = {
    key: "__other__",
    kind: "other",
    otherCount: otherModels.length,
    effectiveTokens: otherEffectiveTokens,
    turns: otherTurns,
    sharePercent: computeSharePercent(otherEffectiveTokens, totalEffectiveTokens),
    tone: "other",
  };

  return {
    totalEffectiveTokens,
    totalModelCount: allModels.length,
    slices: [...primary, otherSlice],
    allModels,
    otherModels,
  };
}
