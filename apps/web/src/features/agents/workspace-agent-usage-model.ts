import { resolveTimeZone } from "#src/lib/dates";
import {
  aggregateAgentTokenUsageSlices,
  summarizeAgentTokenUsage,
  type AgentTokenUsageBucket,
  type AgentTokenUsageBucketSlice,
  type AgentTokenUsageModelEntry,
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
      outputTokens: 0,
      effectiveTokens: 0,
      totalTokens: 0,
      turns: 0,
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
    bucket.outputTokens += entry.outputTokens;
    bucket.effectiveTokens += entry.effectiveTokens;
    bucket.totalTokens += total;
    bucket.turns += entry.turns;

    const modelKey = `${entry.provider}\u0000${entry.model}`;
    const existing = bucket.models.get(modelKey);
    if (existing) {
      existing.effectiveTokens += entry.effectiveTokens;
      existing.totalTokens += total;
      existing.turns += entry.turns;
    } else {
      bucket.models.set(modelKey, {
        provider: entry.provider,
        model: entry.model,
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

  const rows: WorkspaceAgentUsageRow[] = allRows
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
    })
    .sort((a, b) => {
      if (b.effectiveTokens !== a.effectiveTokens) return b.effectiveTokens - a.effectiveTokens;
      if (b.turns !== a.turns) return b.turns - a.turns;
      return a.displayName.localeCompare(b.displayName);
    });

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
