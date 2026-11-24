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
import {
  CalendarHeatmapChart,
  DailyBarChart,
  TodayHourlyChart,
} from "./profile-panel/agent-usage-charts";
import { summarizeWorkspaceAgentUsage } from "./workspace-agent-usage-model";
import { ModelDistributionStrip, UsageRow } from "./workspace-agent-usage-sections";

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
  const timeZone = resolveTimeZone(hydrated ? browserTimeZone() : undefined);
  const loadUsage = useServerFn(getWorkspaceAgentTokenUsage);

  const usageQuery = useQuery({
    queryKey: ["workspace-agent-token-usage", workspaceId, range, timeZone],
    queryFn: () => loadUsage({ data: { range, timeZone } }),
    enabled: hydrated,
    staleTime: 30_000,
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
    return (
      <div role="status" aria-label={m.agents_loading()} className="flex flex-col gap-4">
        <div className="rounded-xl border border-secondary bg-primary p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-44 rounded-lg" />
          </div>
          <Skeleton className="mt-3 h-8 w-32" />
          <Skeleton className="mt-2 h-3.5 w-64" />
          <Skeleton className="mt-5 h-24 w-full" />
        </div>
        <div className="overflow-hidden rounded-xl border border-secondary bg-primary divide-y divide-secondary">
          <Skeleton className="h-14 w-full rounded-none" />
          <Skeleton className="h-14 w-full rounded-none" />
        </div>
      </div>
    );
  }

  const { timelineBuckets, timelineSummary } = view;
  const hasAnyData = timelineSummary.hasAnyData || view.teamEffectiveTokens > 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="overflow-hidden rounded-xl border border-secondary bg-primary">
        <div className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-tertiary">
                {timelineSummary.selectedBucket
                  ? formatSelectedLabel(
                      timelineSummary.selectedBucket.dateKey,
                      timelineSummary.selectedBucket.hour,
                      locale,
                    )
                  : m.agent_usage_team_heading()}
              </h2>
              {timelineSummary.selectedBucket && (
                <Button size="xs" color="link-color" onPress={() => setSelectedKey(null)}>
                  {m.agent_usage_selected_clear()}
                </Button>
              )}
            </div>

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
          </div>

          {hasAnyData ? (
            <>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-2xl font-bold tracking-tight text-primary tabular-nums">
                  {formatCompactTokens(view.visibleEffectiveTokens, locale)}
                </span>
                {!filtersActive && timelineSummary.deltaPercent !== null && (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 font-mono text-xs font-semibold tabular-nums",
                      timelineSummary.deltaPercent > 0
                        ? "bg-warning-primary text-warning-primary"
                        : timelineSummary.deltaPercent < 0
                          ? "bg-success-primary text-success-primary"
                          : "bg-secondary text-tertiary",
                    )}
                  >
                    {timelineSummary.deltaPercent > 0
                      ? `+${timelineSummary.deltaPercent}%`
                      : `${timelineSummary.deltaPercent}%`}
                  </span>
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

              {range === 1 ? (
                <TodayHourlyChart
                  buckets={timelineBuckets}
                  peak={timelineSummary.peakEffective}
                  selectedKey={selectedKey}
                  onToggleSelect={onToggleSelect}
                />
              ) : range === 30 ? (
                <CalendarHeatmapChart
                  buckets={timelineBuckets}
                  peak={timelineSummary.peakEffective}
                  selectedKey={selectedKey}
                  onToggleSelect={onToggleSelect}
                />
              ) : (
                <DailyBarChart
                  buckets={timelineBuckets}
                  peak={timelineSummary.peakEffective}
                  selectedKey={selectedKey}
                  onToggleSelect={onToggleSelect}
                />
              )}
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
        </div>

        {hasAnyData && <ModelDistributionStrip models={timelineSummary.models} locale={locale} />}
      </section>

      {hasAnyData &&
        (view.rows.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-tertiary">
              {m.agent_usage_team_ranking_heading()}
            </h2>
            <div className="overflow-hidden rounded-xl border border-secondary bg-primary">
              <div
                aria-hidden="true"
                className="hidden border-b border-secondary px-4 py-2.5 text-xs font-medium text-tertiary @2xl/members:grid @2xl/members:grid-cols-[minmax(12rem,1fr)_7.5rem_6rem] @2xl/members:gap-3 @4xl/members:grid-cols-[minmax(14rem,1.4fr)_7.5rem_6rem_10.5rem_7.5rem]"
              >
                <span>{m.member_table_col_agent()}</span>
                <span className="text-end">{m.agent_usage_col_tokens()}</span>
                <span className="text-end">{m.agent_usage_col_turns()}</span>
                <span className="hidden @4xl/members:block">{m.agent_usage_col_model()}</span>
                <span className="hidden text-end @4xl/members:block">
                  {m.member_table_col_owner()}
                </span>
              </div>
              <ul
                aria-label={m.agent_usage_team_ranking_heading()}
                className="divide-y divide-secondary"
              >
                {view.rows.map((row) => (
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
