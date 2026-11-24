import { resolveTimeZone } from "#src/lib/dates";
import {
  aggregateAgentTokenUsageSlices,
  summarizeAgentTokenUsage,
  type AgentTokenUsageBucketSlice,
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
}>;

export type WorkspaceAgentBucketEntry = {
  agentId: string;
  bucketKey: string;
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
    const mapKey = `${slice.agentId}\u0000${bucketKey}\u0000${model}`;
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

export function summarizeWorkspaceAgentUsage(
  report: WorkspaceAgentUsageReport,
  filters: {
    selectedKey: string | null;
    owner: "all" | "mine";
    viewerId: string;
    query: string;
  },
): WorkspaceAgentUsageViewSummary {
  const timelineSummary = summarizeAgentTokenUsage(report.timeline, filters.selectedKey);
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
      effectiveTokens,
      newInputTokens: totals?.newInputTokens ?? 0,
      outputTokens: totals?.outputTokens ?? 0,
      cacheReadTokens: totals?.cacheReadTokens ?? 0,
      turns: totals?.turns ?? 0,
      topModel,
    };
  });

  const trimmedQuery = filters.query.trim().toLowerCase();
  let visibleEffectiveTokens = 0;
  let visibleTurns = 0;
  let visibleActiveAgents = 0;

  const rows: WorkspaceAgentUsageRow[] = allRows
    .filter((row) => {
      if (filters.owner === "mine" && row.ownerId !== filters.viewerId) return false;
      if (trimmedQuery && !row.displayName.toLowerCase().includes(trimmedQuery)) return false;
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
    timelineSummary,
    teamEffectiveTokens,
    visibleEffectiveTokens,
    visibleTurns,
    visibleActiveAgents,
    rows,
  };
}
