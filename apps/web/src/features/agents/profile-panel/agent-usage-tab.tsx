import { Suspense, lazy, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, BarChart01 } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import { getAgentTokenUsage } from "#src/features/agents/agent-token-usage.functions";
import { agentTokenUsageKeys } from "#src/features/agents/agent-token-usage-queries";
import {
  formatCompactTokens,
  resolveDefaultUsageProvider,
  summarizeAgentTokenUsage,
  type AgentTokenUsageRange,
  type AgentTokenUsageRuntimeSummary,
} from "#src/features/agents/agent-token-usage-model";
import { browserTimeZone, dateTimeFormat, resolveTimeZone } from "#src/lib/dates";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { AgentTabEmpty } from "./agent-tab-empty";
import type { CacheHitChartDatum } from "./agent-usage-cache-hit-chart";
import { CalendarHeatmapChart, DailyBarChart, TodayHourlyChart } from "./agent-usage-charts";
import {
  UsageAllRuntimesHeader,
  UsageSingleRuntimeHeader,
  UsageToolbar,
} from "./agent-usage-header";
import { UsageModelsSection, UsageTabSkeleton } from "./agent-usage-sections";
import "./agent-usage-motion.css";

const LazyCacheHitChart = lazy(() => import("./agent-usage-cache-hit-chart"));

const ALL_RUNTIMES_CHOICE = "__all__";
const EMPTY_RUNTIMES: readonly AgentTokenUsageRuntimeSummary[] = [];

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

function formatMonthDay(dateKey: string): string {
  const date = Temporal.PlainDate.from(dateKey);
  return `${date.month}/${date.day}`;
}

export function AgentUsageTab({ agentId, timeZone }: { agentId: string; timeZone: string | null }) {
  const hydrated = useHydrated();
  const locale = getLocale();
  const [range, setRange] = useState<AgentTokenUsageRange>(7);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [providerChoice, setProviderChoice] = useState<string | typeof ALL_RUNTIMES_CHOICE | null>(
    null,
  );
  const [metric, setMetric] = useState<"hit" | "tokens">("tokens");

  const effectiveTimeZone = resolveTimeZone(timeZone, hydrated ? browserTimeZone() : undefined);
  const loadUsage = useServerFn(getAgentTokenUsage);

  const query = useQuery({
    queryKey: agentTokenUsageKeys.agentRange(agentId, range, effectiveTimeZone),
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
    refetchOnReconnect: "always",
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === agentId ? previousData : undefined,
  });

  const baseSummary = useMemo(
    () => (query.data ? summarizeAgentTokenUsage(query.data, null, null) : null),
    [query.data],
  );

  const reportRuntimes = baseSummary?.reportRuntimes ?? EMPTY_RUNTIMES;
  const currentProvider = query.data?.currentProvider ?? null;

  const defaultProvider = useMemo(
    () => resolveDefaultUsageProvider(reportRuntimes, currentProvider),
    [reportRuntimes, currentProvider],
  );

  const effectiveProvider = useMemo(() => {
    if (!query.data) return null;
    if (providerChoice === ALL_RUNTIMES_CHOICE) {
      return reportRuntimes.length > 1 ? null : defaultProvider;
    }
    if (
      providerChoice !== null &&
      reportRuntimes.some((runtime) => runtime.provider === providerChoice)
    ) {
      return providerChoice;
    }
    return defaultProvider;
  }, [query.data, providerChoice, reportRuntimes, defaultProvider]);

  const summary = useMemo(
    () =>
      query.data ? summarizeAgentTokenUsage(query.data, selectedKey, effectiveProvider) : null,
    [query.data, selectedKey, effectiveProvider],
  );

  const isAllMultiRuntime = effectiveProvider === null && reportRuntimes.length > 1;
  const activeMetric: "hit" | "tokens" = isAllMultiRuntime ? "tokens" : metric;

  const cacheHitChartData = useMemo<CacheHitChartDatum[]>(() => {
    if (!summary) return [];
    return summary.buckets.map((bucket, index) => ({
      key: bucket.key,
      label: bucket.hour !== undefined ? `${bucket.key}:00` : formatMonthDay(bucket.dateKey),
      tooltipLabel: formatSelectedLabel(bucket.dateKey, bucket.hour, locale),
      hitPercent: summary.cacheHitSeries[index] ?? null,
      cacheReadTokens: bucket.cacheReadTokens,
    }));
  }, [summary, locale]);

  function onChangeRange(next: AgentTokenUsageRange) {
    setRange(next);
    setSelectedKey(null);
  }

  function onSelectProvider(provider: string | null) {
    setProviderChoice(provider ?? ALL_RUNTIMES_CHOICE);
    setSelectedKey(null);
  }

  function onToggleSelect(key: string) {
    setSelectedKey((prev) => (prev === key ? null : key));
  }

  return (
    <div role="region" aria-label={m.agent_usage_tab()} className="flex flex-col pb-6">
      <UsageToolbar
        reportRuntimes={reportRuntimes}
        effectiveProvider={effectiveProvider}
        range={range}
        onSelectProvider={onSelectProvider}
        onChangeRange={onChangeRange}
      />

      {query.isPending ? (
        <UsageTabSkeleton />
      ) : query.isError ? (
        <div className="p-4 sm:p-5">
          <EmptyState
            size="card"
            role="alert"
            picture={<EmptyIcon icon={AlertCircle} size="card" />}
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
          picture={<EmptyIcon icon={BarChart01} />}
          title={m.agent_usage_empty_title()}
          description={m.agent_usage_empty_description()}
        />
      ) : (
        <div
          className={cn(
            "space-y-4 px-4 py-4 transition-opacity sm:px-5",
            query.isPlaceholderData && "opacity-65",
          )}
        >
          <section className="overflow-hidden rounded-xl border border-secondary bg-primary">
            {!isAllMultiRuntime ? (
              <UsageSingleRuntimeHeader
                summary={summary}
                activeMetric={activeMetric}
                locale={locale}
                onSelectMetric={setMetric}
              />
            ) : (
              <UsageAllRuntimesHeader
                summary={summary}
                locale={locale}
                onSelectRuntime={(provider) => onSelectProvider(provider)}
              />
            )}

            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2 text-xs text-tertiary">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate">
                    {summary.selectedBucket
                      ? formatSelectedLabel(
                          summary.selectedBucket.dateKey,
                          summary.selectedBucket.hour,
                          locale,
                        )
                      : activeMetric === "hit"
                        ? m.agent_usage_hit_trend_title()
                        : query.data.range === 1
                          ? m.agent_usage_hourly_trend_title()
                          : m.agent_usage_daily_trend_title()}
                  </span>
                  {summary.selectedBucket && (
                    <Button
                      size="sm"
                      color="link-gray"
                      onPress={() => setSelectedKey(null)}
                      className="usage-clear-enter shrink-0 text-xs"
                    >
                      {m.agent_usage_selected_clear()}
                    </Button>
                  )}
                </div>
                <span className="shrink-0 font-mono tabular-nums">
                  {m.agent_usage_total_summary({
                    tokens: formatCompactTokens(summary.totalTokens, locale),
                  })}
                </span>
              </div>

              <div className="flex min-h-60 flex-col">
                <div
                  key={`${query.data.range}:${activeMetric}`}
                  className="usage-chart-enter flex flex-1 flex-col"
                >
                  {activeMetric === "hit" ? (
                    <Suspense fallback={<Skeleton className="h-60 w-full rounded-lg" />}>
                      <LazyCacheHitChart data={cacheHitChartData} locale={locale} />
                    </Suspense>
                  ) : query.data.range === 1 ? (
                    <TodayHourlyChart
                      buckets={summary.buckets}
                      peak={summary.peakEffective}
                      selectedKey={selectedKey}
                      onToggleSelect={onToggleSelect}
                    />
                  ) : query.data.range === 30 ? (
                    <CalendarHeatmapChart
                      buckets={summary.buckets}
                      peak={summary.peakEffective}
                      selectedKey={selectedKey}
                      onToggleSelect={onToggleSelect}
                    />
                  ) : (
                    <DailyBarChart
                      buckets={summary.buckets}
                      peak={summary.peakEffective}
                      selectedKey={selectedKey}
                      onToggleSelect={onToggleSelect}
                    />
                  )}
                </div>
              </div>
            </div>
          </section>

          <UsageModelsSection
            summary={summary}
            locale={locale}
            groupByRuntime={isAllMultiRuntime}
          />
        </div>
      )}
    </div>
  );
}
