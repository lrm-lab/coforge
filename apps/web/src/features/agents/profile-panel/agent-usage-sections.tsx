import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { Skeleton } from "#src/components/ui/skeleton";
import {
  formatCompactTokens,
  formatExactTokens,
  formatUsagePercent,
  type AgentTokenUsageModelShare,
  type AgentTokenUsageRuntimeSummary,
  type AgentTokenUsageSummary,
} from "#src/features/agents/agent-token-usage-model";
import { runtimeProviderDisplayName } from "#src/features/agents/runtime-provider-display";
import { formatNumber } from "#src/lib/format-number";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export function UsageTabSkeleton() {
  return (
    <div className="space-y-4 px-4 py-4 sm:px-5">
      <div className="overflow-hidden rounded-xl border border-secondary bg-primary">
        <div className="grid grid-cols-2 divide-x divide-secondary border-b border-secondary">
          <div className="space-y-2 px-4 py-3.5">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="space-y-2 px-4 py-3.5">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 w-20" />
          </div>
          <Skeleton className="h-28 w-full rounded-lg" />
          <div className="space-y-2 border-t border-secondary pt-3">
            <Skeleton className="h-2 w-full rounded-full" />
            <div className="grid grid-cols-3 gap-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-full" />
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 w-10" />
        </div>
        <div className="space-y-2.5 rounded-xl border border-secondary bg-primary p-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
    </div>
  );
}

function inputTooltipText(
  newInputTokens: number,
  uncachedInputTokens: number,
  cacheWriteTokens: number,
  locale: string,
): string {
  const total = formatExactTokens(newInputTokens, locale);
  if (cacheWriteTokens <= 0) return total;
  return m.agent_usage_input_tooltip_with_write({
    total,
    uncached: formatExactTokens(uncachedInputTokens, locale),
    cacheWrite: formatExactTokens(cacheWriteTokens, locale),
  });
}

export function UsageTokenCompositionStrip({
  summary,
  locale,
}: {
  summary: AgentTokenUsageSummary;
  locale: string;
}) {
  const uncachedInputTokens = Math.max(0, summary.newInputTokens - summary.cacheWriteTokens);
  return (
    <div className="space-y-2 border-t border-secondary pt-3">
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-secondary">
        {summary.newInputTokens > 0 && (
          <span
            className="block h-full min-w-1 rounded-xs bg-chart-input"
            style={{ width: `${summary.shares.newInputPercent}%` }}
          />
        )}
        {summary.cacheReadTokens > 0 && (
          <span
            className="block h-full min-w-1 rounded-xs bg-chart-cache"
            style={{ width: `${summary.shares.cacheReadPercent}%` }}
          />
        )}
        {summary.outputTokens > 0 && (
          <span
            className="block h-full min-w-1 rounded-xs bg-chart-output"
            style={{ width: `${summary.shares.outputPercent}%` }}
          />
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 font-mono text-xs tabular-nums">
        <div className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-xs bg-chart-input" />
          <span className="truncate font-sans text-tertiary">{m.agent_usage_input_short()}</span>
          <Tooltip
            title={inputTooltipText(
              summary.newInputTokens,
              uncachedInputTokens,
              summary.cacheWriteTokens,
              locale,
            )}
          >
            <TooltipTrigger className="shrink-0 cursor-default rounded-xs font-medium text-primary outline-none focus-visible:ring-2 focus-visible:ring-brand">
              {formatCompactTokens(summary.newInputTokens, locale)}
            </TooltipTrigger>
          </Tooltip>
        </div>
        <div className="flex min-w-0 items-center justify-center gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-xs bg-chart-cache" />
          <span className="truncate font-sans text-tertiary">{m.agent_usage_cached_short()}</span>
          <Tooltip title={formatExactTokens(summary.cacheReadTokens, locale)}>
            <TooltipTrigger className="shrink-0 cursor-default rounded-xs font-medium text-primary outline-none focus-visible:ring-2 focus-visible:ring-brand">
              {formatCompactTokens(summary.cacheReadTokens, locale)}
            </TooltipTrigger>
          </Tooltip>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-xs bg-chart-output" />
          <span className="truncate font-sans text-tertiary">{m.agent_usage_output_short()}</span>
          <Tooltip title={formatExactTokens(summary.outputTokens, locale)}>
            <TooltipTrigger className="shrink-0 cursor-default rounded-xs font-medium text-primary outline-none focus-visible:ring-2 focus-visible:ring-brand">
              {formatCompactTokens(summary.outputTokens, locale)}
            </TooltipTrigger>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function ModelTableCard({
  runtime,
  models,
  locale,
  showRuntimeHeader,
}: {
  runtime: AgentTokenUsageRuntimeSummary | null;
  models: readonly AgentTokenUsageModelShare[];
  locale: string;
  showRuntimeHeader: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-secondary bg-primary">
      {showRuntimeHeader && runtime && (
        <div className="flex items-center justify-between gap-2 border-b border-secondary bg-secondary px-3 py-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 font-semibold text-primary">
            {runtime.isCurrent && (
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-success-solid"
              />
            )}
            <span className="truncate">{runtimeProviderDisplayName(runtime.provider)}</span>
            {runtime.isCurrent && (
              <span className="shrink-0 font-normal text-tertiary">
                {m.agent_usage_current_tag()}
              </span>
            )}
          </span>
          <span
            className={cn(
              "shrink-0 font-mono font-semibold tabular-nums",
              runtime.cacheHitPercent !== null ? "text-success-primary" : "text-quaternary",
            )}
          >
            {runtime.cacheHitPercent !== null
              ? m.agent_usage_hit_rate_inline({
                  percent: formatUsagePercent(runtime.cacheHitPercent, locale),
                })
              : "—"}
          </span>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1.55fr)_repeat(4,minmax(0,0.78fr))] gap-1 border-b border-secondary px-3 py-1.5 text-xs font-medium text-tertiary">
        <span className="truncate">{m.agent_usage_model_col()}</span>
        <span className="whitespace-nowrap text-right">{m.agent_usage_input_short()}</span>
        <span className="whitespace-nowrap text-right">{m.agent_usage_output_short()}</span>
        <span className="whitespace-nowrap text-right">{m.agent_usage_cached_short()}</span>
        <span className="whitespace-nowrap text-right">{m.agent_usage_hit_col()}</span>
      </div>

      <div className="divide-y divide-secondary">
        {models.map((entry) => {
          const modelName = entry.model || m.agent_usage_model_unknown();
          const barWidth = Math.min(100, Math.max(0, entry.sharePercent));
          return (
            <div
              key={`${entry.provider}:${entry.model}`}
              className="relative grid grid-cols-[minmax(0,1.55fr)_repeat(4,minmax(0,0.78fr))] items-center gap-1 overflow-hidden px-3 py-2 font-mono text-xs tabular-nums"
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-0 bg-chart-input/10"
                style={{ width: `${barWidth}%` }}
              />
              <div className="relative min-w-0 font-sans">
                <div className="truncate text-xs font-medium text-primary">{modelName}</div>
                <div className="truncate font-mono text-[0.6875rem] tabular-nums text-tertiary">
                  {formatCompactTokens(entry.effectiveTokens, locale)} ·{" "}
                  {formatUsagePercent(entry.sharePercent, locale)}
                </div>
              </div>
              <div className="relative flex justify-end">
                <Tooltip
                  title={inputTooltipText(
                    entry.newInputTokens,
                    entry.uncachedInputTokens,
                    entry.cacheWriteTokens,
                    locale,
                  )}
                >
                  <TooltipTrigger className="cursor-default truncate rounded-xs text-right text-secondary outline-none focus-visible:ring-2 focus-visible:ring-brand">
                    {formatCompactTokens(entry.newInputTokens, locale)}
                  </TooltipTrigger>
                </Tooltip>
              </div>
              <div className="relative flex justify-end">
                <Tooltip title={formatExactTokens(entry.outputTokens, locale)}>
                  <TooltipTrigger className="cursor-default truncate rounded-xs text-right text-secondary outline-none focus-visible:ring-2 focus-visible:ring-brand">
                    {formatCompactTokens(entry.outputTokens, locale)}
                  </TooltipTrigger>
                </Tooltip>
              </div>
              <div className="relative flex justify-end">
                <Tooltip title={formatExactTokens(entry.cacheReadTokens, locale)}>
                  <TooltipTrigger className="cursor-default truncate rounded-xs text-right text-secondary outline-none focus-visible:ring-2 focus-visible:ring-brand">
                    {formatCompactTokens(entry.cacheReadTokens, locale)}
                  </TooltipTrigger>
                </Tooltip>
              </div>
              <span
                className={cn(
                  "relative truncate text-right font-semibold",
                  entry.cacheHitPercent !== null ? "text-success-primary" : "text-quaternary",
                )}
              >
                {entry.cacheHitPercent !== null
                  ? formatUsagePercent(entry.cacheHitPercent, locale)
                  : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function UsageModelsSection({
  summary,
  locale,
  groupByRuntime,
}: {
  summary: AgentTokenUsageSummary;
  locale: string;
  groupByRuntime: boolean;
}) {
  const groups = groupByRuntime
    ? summary.runtimes
        .map((runtime) => ({
          runtime,
          models: summary.models.filter((entry) => entry.provider === runtime.provider),
        }))
        .filter((group) => group.models.length > 0)
    : [];

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-tertiary">
          {m.agent_usage_models_heading()}
        </span>
        <span className="font-mono text-xs tabular-nums text-quaternary">
          {m.agent_usage_models_count({ count: formatNumber(summary.models.length, locale) })}
        </span>
      </div>

      {summary.models.length === 0 ? (
        <div className="rounded-xl border border-secondary bg-primary px-3 py-4 font-mono text-xs text-quaternary">
          —
        </div>
      ) : groupByRuntime && groups.length > 0 ? (
        <div className="space-y-2.5">
          {groups.map((group) => (
            <ModelTableCard
              key={group.runtime.provider}
              runtime={group.runtime}
              models={group.models}
              locale={locale}
              showRuntimeHeader
            />
          ))}
        </div>
      ) : (
        <ModelTableCard
          runtime={null}
          models={summary.models}
          locale={locale}
          showRuntimeHeader={false}
        />
      )}
    </section>
  );
}
