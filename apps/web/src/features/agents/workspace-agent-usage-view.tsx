import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, BarChart01 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { NoResultsWireframe } from "#src/components/ui/empty-wireframes";
import { Skeleton } from "#src/components/ui/skeleton";
import { browserTimeZone, dateTimeFormat, resolveTimeZone } from "#src/lib/dates";
import { formatNumber } from "#src/lib/format-number";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import {
  AGENT_TOKEN_USAGE_RANGES,
  formatCompactTokens,
  type AgentTokenUsageRange,
} from "./agent-token-usage-model";
import { getWorkspaceAgentTokenUsage } from "./agent-token-usage.functions";
import { agentTokenUsageKeys } from "./agent-token-usage-queries";
import {
  CalendarHeatmapChart,
  DailyBarChart,
  TodayHourlyChart,
} from "./profile-panel/agent-usage-charts";
import {
  DEFAULT_WORKSPACE_AGENT_USAGE_SORT,
  sortWorkspaceAgentUsageRows,
  summarizeWorkspaceAgentUsage,
  toggleWorkspaceAgentUsageSort,
  type WorkspaceAgentUsageSort,
  type WorkspaceAgentUsageSortKey,
} from "./workspace-agent-usage-model";
import { WorkspaceAgentUsageModelDonutCard } from "./workspace-agent-usage-model-donut";
import {
  UsageRankingHeader,
  UsageRankingSortMenu,
  UsageRow,
} from "./workspace-agent-usage-sections";

const RANGE_LABELS: Record<AgentTokenUsageRange, () => string> = {
  1: m.agent_usage_range_today,
  7: m.agent_usage_range_7d,
  14: m.agent_usage_range_14d,
  30: m.agent_usage_range_30d,
};

function formatSelectedLabel(dateKey: string, hour: number | undefined, locale: string): string {
  if (hour !== undefined) return `${String(hour).padStart(2, "0")}:00`;
  const date = Temporal.PlainDate.from(dateKey);
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
  return dateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }).format(utc);
}

function WorkspaceAgentUsageSkeleton() {
  return (
    <div role="status" aria-label={m.agents_loading()} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 @4xl/members:grid-cols-[minmax(0,1.45fr)_minmax(18rem,1fr)]">
        <div className="rounded-xl border border-secondary bg-primary p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-44 rounded-lg" />
          </div>
          <Skeleton className="mt-3 h-8 w-32" />
          <Skeleton className="mt-2 h-3.5 w-64" />
          <Skeleton className="mt-5 h-24 w-full" />
        </div>
        <div className="rounded-xl border border-secondary bg-primary p-4 sm:p-5">
          <Skeleton className="h-4 w-24" />
          <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row">
            <Skeleton className="size-36 shrink-0 rounded-full" />
            <div className="flex w-full flex-1 flex-col gap-2.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-secondary bg-primary divide-y divide-secondary">
        <Skeleton className="h-14 w-full rounded-none" />
        <Skeleton className="h-14 w-full rounded-none" />
      </div>
    </div>
  );
}

function UsageRangeTabs({
  range,
  onChangeRange,
}: {
  range: AgentTokenUsageRange;
  onChangeRange: (next: AgentTokenUsageRange) => void;
}) {
  return (
    <div
      role="group"
      aria-label={m.agent_usage_range_label()}
      className="inline-flex shrink-0 rounded-lg bg-secondary p-0.5"
    >
      {AGENT_TOKEN_USAGE_RANGES.map((option) => {
        const active = range === option;
        return (
          <AriaButton
            key={option}
            aria-pressed={active}
            onPress={() => onChangeRange(option)}
            className={cn(
              "min-h-8 cursor-pointer rounded-md px-2.5 text-xs font-medium outline-none transition-colors data-focus-visible:ring-2 data-focus-visible:ring-brand",
              active
                ? "bg-primary font-semibold text-primary shadow-xs"
                : "text-tertiary hover:text-primary",
            )}
          >
            {RANGE_LABELS[option]()}
          </AriaButton>
        );
      })}
    </div>
  );
}

function UsageDeltaBadge({ deltaPercent }: { deltaPercent: number }) {
  const toneClass =
    deltaPercent > 0
      ? "bg-warning-primary text-warning-primary"
      : deltaPercent < 0
        ? "bg-success-primary text-success-primary"
        : "bg-secondary text-tertiary";

  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 font-mono text-xs font-semibold tabular-nums",
        toneClass,
      )}
    >
      {deltaPercent > 0 ? `+${deltaPercent}%` : `${deltaPercent}%`}
    </span>
  );
}

function UsageTimelinePlot({
  range,
  buckets,
  peak,
  selectedKey,
  onToggleSelect,
}: {
  range: AgentTokenUsageRange;
  buckets: ReturnType<typeof summarizeWorkspaceAgentUsage>["timelineBuckets"];
  peak: number;
  selectedKey: string | null;
  onToggleSelect: (key: string) => void;
}) {
  if (range === 1) {
    return (
      <TodayHourlyChart
        buckets={buckets}
        peak={peak}
        selectedKey={selectedKey}
        onToggleSelect={onToggleSelect}
      />
    );
  }
  if (range === 30) {
    return (
      <CalendarHeatmapChart
        buckets={buckets}
        peak={peak}
        selectedKey={selectedKey}
        onToggleSelect={onToggleSelect}
      />
    );
  }
  return (
    <DailyBarChart
      buckets={buckets}
      peak={peak}
      selectedKey={selectedKey}
      onToggleSelect={onToggleSelect}
    />
  );
}

function WorkspaceAgentUsageTrendCard({
  range,
  selectedKey,
  locale,
  filtersActive,
  hasAnyData,
  avgPerTurn,
  view,
  onChangeRange,
  onClearSelected,
  onToggleSelect,
}: {
  range: AgentTokenUsageRange;
  selectedKey: string | null;
  locale: string;
  filtersActive: boolean;
  hasAnyData: boolean;
  avgPerTurn: number | null;
  view: ReturnType<typeof summarizeWorkspaceAgentUsage>;
  onChangeRange: (next: AgentTokenUsageRange) => void;
  onClearSelected: () => void;
  onToggleSelect: (key: string) => void;
}) {
  const { timelineBuckets, timelineSummary } = view;
  const heading = timelineSummary.selectedBucket
    ? formatSelectedLabel(
        timelineSummary.selectedBucket.dateKey,
        timelineSummary.selectedBucket.hour,
        locale,
      )
    : m.agent_usage_team_heading();

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-secondary bg-primary p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-tertiary">{heading}</h2>
          {timelineSummary.selectedBucket && (
            <Button size="xs" color="link-color" onPress={onClearSelected}>
              {m.agent_usage_selected_clear()}
            </Button>
          )}
        </div>
        <UsageRangeTabs range={range} onChangeRange={onChangeRange} />
      </div>

      {hasAnyData ? (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-2xl font-bold tracking-tight text-primary tabular-nums">
              {formatCompactTokens(view.visibleEffectiveTokens, locale)}
            </span>
            {!filtersActive && timelineSummary.deltaPercent !== null && (
              <UsageDeltaBadge deltaPercent={timelineSummary.deltaPercent} />
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-tertiary tabular-nums">
            <span>
              {m.agent_usage_team_summary_active({
                count: formatNumber(view.visibleActiveAgents, locale),
              })}
            </span>
            <span>
              {m.agent_usage_team_summary_turns({
                turns: formatNumber(view.visibleTurns, locale),
              })}
            </span>
            {avgPerTurn !== null && (
              <span>
                {m.agent_usage_team_avg_turn({
                  tokens: formatCompactTokens(avgPerTurn, locale),
                })}
              </span>
            )}
          </div>

          <UsageTimelinePlot
            range={range}
            buckets={timelineBuckets}
            peak={timelineSummary.peakEffective}
            selectedKey={selectedKey}
            onToggleSelect={onToggleSelect}
          />
        </>
      ) : (
        <EmptyState
          size="card"
          headingLevel={3}
          picture={<EmptyIcon icon={BarChart01} />}
          title={m.agent_usage_empty_title()}
          description={m.agent_usage_team_empty_description()}
        />
      )}
    </section>
  );
}

export function WorkspaceAgentUsageView({
  workspaceId,
  viewerId,
  owner,
  query,
  profileAgentId,
  onClearFilters,
}: {
  workspaceId: string;
  viewerId: string;
  owner: "all" | "mine";
  query: string;
  profileAgentId?: string;
  onClearFilters: () => void;
}) {
  const hydrated = useHydrated();
  const locale = getLocale();
  const [range, setRange] = useState<AgentTokenUsageRange>(7);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sort, setSort] = useState<WorkspaceAgentUsageSort>(DEFAULT_WORKSPACE_AGENT_USAGE_SORT);
  const timeZone = resolveTimeZone(hydrated ? browserTimeZone() : undefined);
  const loadUsage = useServerFn(getWorkspaceAgentTokenUsage);

  const usageQuery = useQuery({
    queryKey: agentTokenUsageKeys.workspaceRange(workspaceId, range, timeZone),
    queryFn: () => loadUsage({ data: { range, timeZone } }),
    enabled: hydrated,
    staleTime: 30_000,
    refetchOnReconnect: "always",
  });

  const view = useMemo(
    () =>
      usageQuery.data
        ? summarizeWorkspaceAgentUsage(usageQuery.data, {
            selectedKey,
            owner,
            viewerId,
            query,
          })
        : null,
    [usageQuery.data, selectedKey, owner, viewerId, query],
  );

  const sortedRows = useMemo(
    () => (view ? sortWorkspaceAgentUsageRows(view.rows, sort, locale) : []),
    [view, sort, locale],
  );

  const trimmedQuery = query.trim();
  const filtersActive = owner === "mine" || Boolean(trimmedQuery);
  const avgPerTurn =
    view && view.visibleTurns > 0
      ? Math.round(view.visibleEffectiveTokens / view.visibleTurns)
      : null;

  function onChangeRange(next: AgentTokenUsageRange) {
    setRange(next);
    setSelectedKey(null);
  }

  function onToggleSelect(key: string) {
    setSelectedKey((prev) => (prev === key ? null : key));
  }

  function onSortColumn(key: WorkspaceAgentUsageSortKey) {
    setSort((prev) => toggleWorkspaceAgentUsageSort(prev, key));
  }

  if (usageQuery.isError && !usageQuery.data) {
    return (
      <EmptyState
        size="page"
        role="alert"
        picture={<EmptyIcon icon={AlertCircle} />}
        title={m.agent_usage_load_failed()}
        primaryAction={
          <RetryButton
            size="page"
            isRetrying={usageQuery.isRefetching}
            onPress={() => void usageQuery.refetch()}
          />
        }
      />
    );
  }

  if (usageQuery.isPending || !usageQuery.data || !view) {
    return <WorkspaceAgentUsageSkeleton />;
  }

  const { timelineSummary } = view;
  const hasAnyData = timelineSummary.hasAnyData || view.teamEffectiveTokens > 0;
  const hasModelDistribution =
    hasAnyData && timelineSummary.models.some((entry) => entry.effectiveTokens > 0);

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "grid grid-cols-1 gap-4",
          hasModelDistribution &&
            "@4xl/members:grid-cols-[minmax(0,1.45fr)_minmax(18rem,1fr)] @4xl/members:items-stretch",
        )}
      >
        <WorkspaceAgentUsageTrendCard
          range={range}
          selectedKey={selectedKey}
          locale={locale}
          filtersActive={filtersActive}
          hasAnyData={hasAnyData}
          avgPerTurn={avgPerTurn}
          view={view}
          onChangeRange={onChangeRange}
          onClearSelected={() => setSelectedKey(null)}
          onToggleSelect={onToggleSelect}
        />

        {hasModelDistribution && (
          <WorkspaceAgentUsageModelDonutCard models={timelineSummary.models} locale={locale} />
        )}
      </div>

      {hasAnyData &&
        (sortedRows.length > 0 ? (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-medium text-tertiary">
                {m.agent_usage_team_ranking_heading()}
              </h2>
              <UsageRankingSortMenu sort={sort} onSort={onSortColumn} />
            </div>
            <div className="overflow-hidden rounded-xl border border-secondary bg-primary">
              <UsageRankingHeader sort={sort} onSort={onSortColumn} />
              <ul
                aria-label={m.agent_usage_team_ranking_heading()}
                className="divide-y divide-secondary"
              >
                {sortedRows.map((row) => (
                  <UsageRow
                    key={row.agentId}
                    row={row}
                    selected={row.agentId === profileAgentId}
                    locale={locale}
                  />
                ))}
              </ul>
            </div>
          </section>
        ) : (
          <EmptyState
            size="card"
            headingLevel={3}
            live="polite"
            picture={<NoResultsWireframe />}
            title={
              trimmedQuery
                ? m.empty_members_no_match_query({ query: trimmedQuery })
                : m.empty_members_filter_empty_title()
            }
            description={m.member_filter_empty_description()}
            primaryAction={
              <Button size="sm" color="secondary" onPress={onClearFilters}>
                {owner === "mine" ? m.member_clear_filters() : m.agent_clear_search()}
              </Button>
            }
          />
        ))}
    </div>
  );
}
