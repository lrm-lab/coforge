import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { HelpCircle } from "@untitledui/icons";
import { ChartBar, CircleAlert } from "kubai-icons/duotone";
import { Button as AriaButton } from "react-aria-components";
import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { getAgentTokenUsage } from "#src/features/agents/agent-token-usage.functions";
import {
  AGENT_TOKEN_USAGE_RANGES,
  formatCompactTokens,
  formatExactTokens,
  formatUsagePercent,
  summarizeAgentTokenUsage,
  type AgentTokenUsageRange,
} from "#src/features/agents/agent-token-usage-model";
import { browserTimeZone, dateTimeFormat, resolveTimeZone } from "#src/lib/dates";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { AgentTabEmpty } from "./agent-tab-empty";
import { CalendarHeatmapChart, DailyBarChart, TodayHourlyChart } from "./agent-usage-charts";
import {
  UsageBreakdownSection,
  UsageContextSection,
  UsageModelsSection,
  UsageTabSkeleton,
} from "./agent-usage-sections";

const RANGE_LABELS: Record<AgentTokenUsageRange, () => string> = {
  1: m.agent_usage_range_today,
  7: m.agent_usage_range_7d,
  14: m.agent_usage_range_14d,
  30: m.agent_usage_range_30d,
};

function formatClock(iso: string, zone: string, locale: string): string {
  return dateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: zone,
  }).format(new Date(iso));
}

function formatShortDate(iso: string, zone: string, locale: string): string {
  return dateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    timeZone: zone,
  }).format(new Date(iso));
}

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

export function AgentUsageTab({ agentId, timeZone }: { agentId: string; timeZone: string | null }) {
  const hydrated = useHydrated();
  const locale = getLocale();
  const [range, setRange] = useState<AgentTokenUsageRange>(7);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const effectiveTimeZone = resolveTimeZone(timeZone, hydrated ? browserTimeZone() : undefined);
  const loadUsage = useServerFn(getAgentTokenUsage);

  const query = useQuery({
    queryKey: ["agent-token-usage", agentId, range, effectiveTimeZone],
    queryFn: () =>
      loadUsage({
        data: {
          agentId,
          range,
          timeZone: effectiveTimeZone,
        },
      }),
    enabled: hydrated || Boolean(timeZone),
    staleTime: 30_000,
  });

  const summary = useMemo(
    () => (query.data ? summarizeAgentTokenUsage(query.data, selectedKey) : null),
    [query.data, selectedKey],
  );

  const selectedIndex = useMemo(() => {
    if (!query.data || selectedKey === null) return null;
    const idx = query.data.buckets.findIndex((b) => b.key === selectedKey);
    return idx >= 0 ? idx : null;
  }, [query.data, selectedKey]);

  function onChangeRange(next: AgentTokenUsageRange) {
    setRange(next);
    setSelectedKey(null);
  }

  function onToggleSelect(key: string) {
    setSelectedKey((prev) => (prev === key ? null : key));
  }

  return (
    <div role="region" aria-label={m.agent_usage_tab()} className="flex flex-col pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 sm:px-6">
        <div
          role="group"
          aria-label={m.agent_usage_range_label()}
          className="inline-flex rounded-lg bg-secondary p-0.5"
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
        {hydrated && query.data && (
          <span className="font-mono text-xs tabular-nums text-quaternary">
            {m.agent_usage_as_of({
              time: formatClock(query.data.asOf, query.data.timeZone, locale),
            })}
          </span>
        )}
      </div>

      {query.isPending ? (
        <UsageTabSkeleton />
      ) : query.isError ? (
        <div className="p-5">
          <EmptyState
            size="card"
            role="alert"
            picture={<EmptyIcon icon={CircleAlert} size="card" />}
            title={m.agent_usage_load_failed()}
            primaryAction={
              <RetryButton
                size="card"
                label={m.agent_usage_retry()}
                isRetrying={query.isRefetching}
                onPress={() => {
                  void query.refetch();
                }}
              />
            }
          />
        </div>
      ) : !query.data || !summary ? null : !summary.hasAnyData ? (
        <AgentTabEmpty
          belowBar
          level={3}
          picture={<EmptyIcon icon={ChartBar} />}
          title={m.agent_usage_empty_title()}
          description={m.agent_usage_empty_description()}
        />
      ) : (
        <>
          <section className="border-b border-secondary px-5 py-5 sm:px-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs font-semibold text-tertiary">
                {summary.selectedBucket
                  ? `${formatSelectedLabel(summary.selectedBucket.dateKey, summary.selectedBucket.hour, locale)} · ${m.agent_usage_effective_heading()}`
                  : m.agent_usage_effective_heading()}
              </p>
              {summary.selectedBucket ? (
                <Button
                  size="sm"
                  color="link-gray"
                  onPress={() => setSelectedKey(null)}
                  className="text-xs"
                >
                  {m.agent_usage_selected_clear()}
                </Button>
              ) : hydrated && query.data.trackingStartedAt ? (
                <span className="text-xs text-quaternary">
                  {m.agent_usage_tracking_since({
                    date: formatShortDate(
                      query.data.trackingStartedAt,
                      query.data.timeZone,
                      locale,
                    ),
                  })}
                </span>
              ) : null}
            </div>

            <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <Tooltip title={formatExactTokens(summary.effectiveTokens, locale)}>
                  <TooltipTrigger className="cursor-default rounded-xs font-mono text-2xl font-bold tracking-tight tabular-nums text-primary outline-none focus-visible:ring-2 focus-visible:ring-brand">
                    {formatCompactTokens(summary.effectiveTokens, locale)}
                  </TooltipTrigger>
                </Tooltip>
                <span
                  className={cn(
                    "font-mono text-xs font-medium tabular-nums",
                    summary.deltaPercent === null
                      ? "text-quaternary"
                      : summary.deltaPercent > 0
                        ? "text-success-primary"
                        : summary.deltaPercent < 0
                          ? "text-tertiary"
                          : "text-quaternary",
                  )}
                >
                  {summary.deltaPercent === null
                    ? "—"
                    : `${summary.deltaPercent > 0 ? "+" : ""}${summary.deltaPercent}%`}
                </span>
              </div>

              {summary.cacheHitPercent !== null && (
                <Tooltip title={m.agent_usage_cache_hit_help()}>
                  <TooltipTrigger className="inline-flex items-center gap-1 rounded-full bg-success-primary px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-success-primary outline-none focus-visible:ring-2 focus-visible:ring-brand">
                    <span>
                      {m.agent_usage_cache_hit({
                        percent: formatUsagePercent(summary.cacheHitPercent, locale),
                      })}
                    </span>
                    <HelpCircle className="size-3 shrink-0 opacity-80" aria-hidden="true" />
                  </TooltipTrigger>
                </Tooltip>
              )}
            </div>

            <p className="mt-1 font-mono text-xs tabular-nums text-quaternary">
              {m.agent_usage_total_throughput({
                total: formatCompactTokens(summary.totalTokens, locale),
                cache: formatCompactTokens(summary.cacheReadTokens, locale),
              })}
            </p>

            {query.data.range === 1 ? (
              <TodayHourlyChart
                buckets={query.data.buckets}
                peak={summary.peakEffective}
                selectedKey={selectedKey}
                onToggleSelect={onToggleSelect}
              />
            ) : query.data.range === 30 ? (
              <CalendarHeatmapChart
                buckets={query.data.buckets}
                peak={summary.peakEffective}
                selectedKey={selectedKey}
                onToggleSelect={onToggleSelect}
              />
            ) : (
              <DailyBarChart
                buckets={query.data.buckets}
                peak={summary.peakEffective}
                selectedKey={selectedKey}
                onToggleSelect={onToggleSelect}
              />
            )}
          </section>

          <UsageBreakdownSection summary={summary} selectedIndex={selectedIndex} locale={locale} />
          <UsageContextSection summary={summary} range={query.data.range} locale={locale} />
          <UsageModelsSection summary={summary} locale={locale} />
        </>
      )}
    </div>
  );
}
