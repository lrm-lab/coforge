import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useHydrated, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChartBar, CircleAlert } from "kubai-icons/duotone";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { NoResultsWireframe } from "#src/components/ui/empty-wireframes";
import { Skeleton } from "#src/components/ui/skeleton";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { browserTimeZone, dateTimeFormat, resolveTimeZone } from "#src/lib/dates";
import { formatNumber } from "#src/lib/format-number";
import { rememberSharedRect } from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import { AgentDisplayAvatar } from "./agent-display-avatar";
import {
  AGENT_TOKEN_USAGE_RANGES,
  formatCompactTokens,
  formatExactTokens,
  formatUsagePercent,
  type AgentTokenUsageModelShare,
  type AgentTokenUsageRange,
} from "./agent-token-usage-model";
import { getWorkspaceAgentTokenUsage } from "./agent-token-usage.functions";
import {
  CalendarHeatmapChart,
  DailyBarChart,
  TodayHourlyChart,
} from "./profile-panel/agent-usage-charts";
import { formatAgentProfileParam } from "./profile-panel/profile-panel-search";
import { useAgentModelName } from "./use-agent-model-name";
import { useLiveAgentDisplay } from "./workspace-agents-realtime";
import {
  summarizeWorkspaceAgentUsage,
  type WorkspaceAgentUsageRow,
} from "./workspace-agent-usage-model";

const RANGE_LABELS: Record<AgentTokenUsageRange, () => string> = {
  1: m.agent_usage_range_today,
  7: m.agent_usage_range_7d,
  14: m.agent_usage_range_14d,
  30: m.agent_usage_range_30d,
};

const MODEL_SWATCH_CLASSES = [
  "bg-chart-input",
  "bg-chart-output",
  "bg-chart-cache",
  "bg-quaternary",
] as const;

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

function ModelDistributionStrip({
  models,
  locale,
}: {
  models: readonly AgentTokenUsageModelShare[];
  locale: string;
}) {
  const nonZero = models.filter((entry) => entry.effectiveTokens > 0);
  if (nonZero.length === 0) return null;

  return (
    <div className="border-t border-secondary px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-tertiary">
          {m.agent_usage_team_models_heading()}
        </span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {nonZero.slice(0, 4).map((entry, index) => (
            <span
              key={`${entry.provider}:${entry.model}`}
              className="inline-flex items-center gap-1.5 text-secondary tabular-nums"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  MODEL_SWATCH_CLASSES[index % MODEL_SWATCH_CLASSES.length],
                )}
              />
              <span className="max-w-40 truncate font-mono text-primary">
                {entry.model || m.agent_usage_model_unknown()}
              </span>
              <span className="text-tertiary">
                {formatUsagePercent(entry.sharePercent, locale)}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="mt-2.5 flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-secondary">
        {nonZero.slice(0, 4).map((entry, index) => (
          <span
            key={`${entry.provider}:${entry.model}`}
            className={cn(
              "block h-full min-w-1 rounded-xs",
              MODEL_SWATCH_CLASSES[index % MODEL_SWATCH_CLASSES.length],
            )}
            style={{ width: `${entry.sharePercent}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function UsageRow({
  row,
  selected,
  locale,
}: {
  row: WorkspaceAgentUsageRow;
  selected: boolean;
  locale: string;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const navigate = useNavigate();
  const display = useLiveAgentDisplay(row.agentId);
  const resolvedModel = useAgentModelName(row.agentId, row.topModel);
  const shareLabel =
    row.effectiveTokens > 0
      ? m.agent_usage_team_share({ percent: formatUsagePercent(row.teamSharePercent, locale) })
      : m.agent_usage_no_usage_short();
  const hoverDetail =
    row.effectiveTokens > 0
      ? m.agent_usage_hover_detail({
          exact: formatExactTokens(row.effectiveTokens, locale),
          newInput: formatCompactTokens(row.newInputTokens, locale),
          output: formatCompactTokens(row.outputTokens, locale),
        })
      : undefined;

  function openUsageProfile() {
    void navigate({
      to: "/w/$workspaceSlug/members",
      params: { workspaceSlug },
      resetScroll: false,
      search: (previous) => ({
        ...previous,
        profile: formatAgentProfileParam(row.agentId),
        agentTab: "usage",
      }),
    });
  }

  return (
    <li
      className={cn(
        "relative flex min-w-0 cursor-pointer flex-col gap-2 px-4 py-3 transition-colors hover:bg-primary_hover @2xl/members:grid @2xl/members:grid-cols-[minmax(12rem,1fr)_7.5rem_6rem] @2xl/members:items-center @2xl/members:gap-3 @4xl/members:grid-cols-[minmax(14rem,1.4fr)_7.5rem_6rem_10.5rem_7.5rem]",
        selected && "bg-chat-selected-bg",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <AgentDisplayAvatar
          agentId={row.agentId}
          name={row.displayName}
          src={row.avatarUrl}
          display={display}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold text-primary">
              <Link
                to="/w/$workspaceSlug/members"
                params={{ workspaceSlug }}
                resetScroll={false}
                search={(previous) => ({
                  ...previous,
                  profile: formatAgentProfileParam(row.agentId),
                  agentTab: "usage",
                })}
                onClick={(event) => {
                  const rowEl =
                    event.currentTarget.closest<HTMLElement>("li") ?? event.currentTarget;
                  rememberSharedRect("member-profile-origin", rowEl);
                }}
                aria-label={m.agent_open_profile({ name: row.displayName })}
                aria-current={selected ? "page" : undefined}
                className="rounded-sm outline-focus-ring outline-offset-4 after:absolute after:inset-0 focus-visible:outline-2"
              >
                {row.displayName}
              </Link>
            </h3>
            <span className="shrink-0 text-sm font-semibold text-primary tabular-nums @2xl/members:hidden">
              {formatCompactTokens(row.effectiveTokens, locale)}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-tertiary @2xl/members:hidden">
            {row.effectiveTokens > 0 && <span className="tabular-nums">{shareLabel}</span>}
            <span className="tabular-nums">
              {m.agent_usage_team_summary_turns({ turns: formatNumber(row.turns, locale) })}
            </span>
            {resolvedModel && <span className="truncate font-mono">{resolvedModel}</span>}
          </div>
        </div>
      </div>

      <div className="hidden min-w-0 justify-end @2xl/members:flex">
        <Tooltip title={shareLabel} description={hoverDetail} delay={120} placement="top">
          <TooltipTrigger
            onPress={openUsageProfile}
            className="relative z-10 cursor-pointer rounded-sm px-1.5 py-0.5 text-end text-sm font-semibold text-primary tabular-nums outline-focus-ring transition-colors hover:bg-secondary focus-visible:outline-2"
          >
            {formatCompactTokens(row.effectiveTokens, locale)}
          </TooltipTrigger>
        </Tooltip>
      </div>

      <div className="hidden min-w-0 truncate text-end text-xs text-secondary tabular-nums @2xl/members:block">
        {formatNumber(row.turns, locale)}
      </div>

      <div className="hidden min-w-0 truncate font-mono text-xs text-tertiary @4xl/members:block">
        {resolvedModel || "—"}
      </div>

      <div className="hidden min-w-0 truncate text-end text-xs text-tertiary @4xl/members:block">
        {row.ownerDisplayName}
      </div>
    </li>
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
        picture={<EmptyIcon icon={CircleAlert} />}
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

  const timeline = usageQuery.data.timeline;
  const { timelineSummary } = view;
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
                  buckets={timeline.buckets}
                  peak={timelineSummary.peakEffective}
                  selectedKey={selectedKey}
                  onToggleSelect={onToggleSelect}
                />
              ) : range === 30 ? (
                <CalendarHeatmapChart
                  buckets={timeline.buckets}
                  peak={timelineSummary.peakEffective}
                  selectedKey={selectedKey}
                  onToggleSelect={onToggleSelect}
                />
              ) : (
                <DailyBarChart
                  buckets={timeline.buckets}
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
              picture={<EmptyIcon icon={ChartBar} />}
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
