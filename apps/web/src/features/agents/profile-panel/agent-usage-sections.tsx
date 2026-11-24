import { parseRuntimeProvider } from "@lrm/coforge-sdk/internal";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { Skeleton } from "#src/components/ui/skeleton";
import {
  formatCompactTokens,
  formatExactTokens,
  formatUsagePercent,
  type AgentTokenUsageSummary,
} from "#src/features/agents/agent-token-usage-model";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { InlineSparkline } from "./agent-usage-charts";

export function UsageTabSkeleton() {
  return (
    <div className="flex flex-col">
      <div className="border-b border-secondary px-5 py-5 sm:px-6">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="mt-3 h-7 w-28" />
        <Skeleton className="mt-2 h-3.5 w-52" />
        <Skeleton className="mt-5 h-24 w-full" />
      </div>
      <div className="border-b border-secondary px-5 py-5 sm:px-6">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-2 w-full rounded-full" />
        <div className="mt-4 space-y-2.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
      <div className="px-5 py-5 sm:px-6">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-3 h-4 w-48" />
        <Skeleton className="mt-2.5 h-4 w-40" />
      </div>
    </div>
  );
}

export function UsageBreakdownSection({
  summary,
  selectedIndex,
  locale,
}: {
  summary: AgentTokenUsageSummary;
  selectedIndex: number | null;
  locale: string;
}) {
  return (
    <section className="border-b border-secondary px-5 py-5 sm:px-6">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-tertiary">{m.agent_usage_breakdown_heading()}</p>
        <span className="text-xs text-quaternary">{m.agent_usage_breakdown_note()}</span>
      </div>

      <div className="mt-3 flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-secondary">
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

      <div className="mt-3.5 flex flex-col gap-2.5">
        <BreakdownRow
          label={m.agent_usage_type_new_input()}
          swatchClassName="bg-chart-input"
          strokeClassName="stroke-chart-input"
          fillClassName="fill-chart-input"
          values={summary.series.newInput}
          selectedIndex={selectedIndex}
          tokens={summary.newInputTokens}
          sharePercent={summary.shares.newInputPercent}
          locale={locale}
        />
        <BreakdownRow
          label={m.agent_usage_type_cache_read()}
          swatchClassName="bg-chart-cache"
          strokeClassName="stroke-chart-cache"
          fillClassName="fill-chart-cache"
          values={summary.series.cacheRead}
          selectedIndex={selectedIndex}
          tokens={summary.cacheReadTokens}
          sharePercent={summary.shares.cacheReadPercent}
          locale={locale}
        />
        <BreakdownRow
          label={m.agent_usage_type_output()}
          swatchClassName="bg-chart-output"
          strokeClassName="stroke-chart-output"
          fillClassName="fill-chart-output"
          values={summary.series.output}
          selectedIndex={selectedIndex}
          tokens={summary.outputTokens}
          sharePercent={summary.shares.outputPercent}
          locale={locale}
        />
      </div>
    </section>
  );
}

export function UsageModelsSection({
  summary,
  locale,
}: {
  summary: AgentTokenUsageSummary;
  locale: string;
}) {
  return (
    <section className="px-5 py-5 sm:px-6">
      <p className="text-xs font-semibold text-tertiary">{m.agent_usage_models_heading()}</p>
      {summary.models.length === 0 ? (
        <p className="mt-3 font-mono text-xs text-quaternary">—</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {summary.models.map((entry) => {
            const provider = parseRuntimeProvider(entry.provider);
            const runtimeName = provider ? runtimeProviderLabel(provider) : entry.provider;
            const modelName = entry.model || m.agent_usage_model_unknown();
            return (
              <div key={`${entry.provider}:${entry.model}`} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-primary">{modelName}</span>
                    <span className="shrink-0 text-xs text-tertiary">{runtimeName}</span>
                  </div>
                  <div className="flex shrink-0 items-baseline gap-2 font-mono text-xs tabular-nums">
                    <Tooltip title={formatExactTokens(entry.effectiveTokens, locale)}>
                      <TooltipTrigger className="cursor-default rounded-xs text-tertiary outline-none focus-visible:ring-2 focus-visible:ring-brand">
                        {formatCompactTokens(entry.effectiveTokens, locale)}
                      </TooltipTrigger>
                    </Tooltip>
                    <span className="font-semibold text-primary">
                      {formatUsagePercent(entry.sharePercent, locale)}
                    </span>
                  </div>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
                  <span
                    className="block h-full rounded-full bg-chart-input"
                    style={{ width: `${Math.min(100, Math.max(0, entry.sharePercent))}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function BreakdownRow({
  label,
  swatchClassName,
  strokeClassName,
  fillClassName,
  values,
  selectedIndex,
  tokens,
  sharePercent,
  locale,
}: {
  label: string;
  swatchClassName: string;
  strokeClassName: string;
  fillClassName: string;
  values: readonly number[];
  selectedIndex: number | null;
  tokens: number;
  sharePercent: number;
  locale: string;
}) {
  return (
    <div className="grid grid-cols-[6.25rem_minmax(0,1fr)_7.75rem] items-center gap-2">
      <span className="inline-flex min-w-0 items-center gap-2 text-xs font-medium text-secondary">
        <span className={cn("size-2 shrink-0 rounded-xs", swatchClassName)} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      <div className="flex min-w-0 justify-center">
        <InlineSparkline
          values={values}
          strokeClassName={strokeClassName}
          fillClassName={fillClassName}
          selectedIndex={selectedIndex}
        />
      </div>
      <div className="flex shrink-0 items-baseline justify-end gap-1.5 font-mono text-xs tabular-nums">
        <Tooltip title={formatExactTokens(tokens, locale)}>
          <TooltipTrigger className="cursor-default rounded-xs font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-brand">
            {formatCompactTokens(tokens, locale)}
          </TooltipTrigger>
        </Tooltip>
        <span className="w-10 text-right text-quaternary">
          {formatUsagePercent(sharePercent, locale)}
        </span>
      </div>
    </div>
  );
}
