import { useMemo } from "react";
import { HelpCircle } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { Select, type SelectItemType } from "#src/components/base/select/select";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import {
  AGENT_TOKEN_USAGE_RANGES,
  formatCompactTokens,
  formatExactTokens,
  formatUsagePercent,
  type AgentTokenUsageRange,
  type AgentTokenUsageRuntimeSummary,
  type AgentTokenUsageSummary,
} from "#src/features/agents/agent-token-usage-model";
import { runtimeProviderDisplayName } from "#src/features/agents/runtime-provider-display";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

const ALL_RUNTIMES_KEY = "__all__";

const RANGE_LABELS: Record<AgentTokenUsageRange, () => string> = {
  1: m.agent_usage_range_today,
  7: m.agent_usage_range_7d,
  14: m.agent_usage_range_14d,
  30: m.agent_usage_range_30d,
};

export function UsageToolbar({
  reportRuntimes,
  effectiveProvider,
  range,
  onSelectProvider,
  onChangeRange,
}: {
  reportRuntimes: readonly AgentTokenUsageRuntimeSummary[];
  effectiveProvider: string | null;
  range: AgentTokenUsageRange;
  onSelectProvider: (provider: string | null) => void;
  onChangeRange: (next: AgentTokenUsageRange) => void;
}) {
  const runtimeItems = useMemo<SelectItemType[]>(() => {
    if (reportRuntimes.length <= 1) return [];
    const items: SelectItemType[] = reportRuntimes.map((runtime) => ({
      id: runtime.provider,
      label: runtimeProviderDisplayName(runtime.provider),
      supportingText: runtime.isCurrent ? m.agent_usage_current_tag() : undefined,
      icon: (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            runtime.isCurrent ? "bg-success-solid" : "bg-chart-input",
          )}
        />
      ),
    }));
    items.push({
      id: ALL_RUNTIMES_KEY,
      label: m.agent_usage_all_runtimes(),
      icon: <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-chart-input" />,
    });
    return items;
  }, [reportRuntimes]);

  const rangeItems = useMemo<SelectItemType[]>(
    () =>
      AGENT_TOKEN_USAGE_RANGES.map((option) => ({
        id: String(option),
        label: RANGE_LABELS[option](),
      })),
    [],
  );

  const soleRuntime = reportRuntimes.length === 1 ? reportRuntimes[0]! : null;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-secondary px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        {reportRuntimes.length > 1 ? (
          <Select
            aria-label={m.agent_usage_runtime_label()}
            size="sm"
            items={runtimeItems}
            selectedKey={effectiveProvider ?? ALL_RUNTIMES_KEY}
            onSelectionChange={(key) => {
              if (key === null) return;
              const value = String(key);
              onSelectProvider(value === ALL_RUNTIMES_KEY ? null : value);
            }}
            className="w-full max-w-56"
          >
            {(item) => (
              <Select.Item
                id={item.id}
                label={item.label}
                supportingText={item.supportingText}
                icon={item.icon}
              />
            )}
          </Select>
        ) : soleRuntime ? (
          <div className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-lg border border-secondary bg-primary px-3 text-sm font-medium text-primary">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                soleRuntime.isCurrent ? "bg-success-solid" : "bg-chart-input",
              )}
            />
            <span className="truncate">{runtimeProviderDisplayName(soleRuntime.provider)}</span>
            {soleRuntime.isCurrent && (
              <span className="shrink-0 text-xs font-normal text-tertiary">
                {m.agent_usage_current_tag()}
              </span>
            )}
          </div>
        ) : null}
      </div>

      <Select
        aria-label={m.agent_usage_range_label()}
        size="sm"
        items={rangeItems}
        selectedKey={String(range)}
        onSelectionChange={(key) => {
          if (key === null) return;
          const parsed = Number(key) as AgentTokenUsageRange;
          if (AGENT_TOKEN_USAGE_RANGES.includes(parsed)) onChangeRange(parsed);
        }}
        className="w-26 shrink-0"
      >
        {(item) => <Select.Item id={item.id} label={item.label} />}
      </Select>
    </div>
  );
}

export function UsageSingleRuntimeHeader({
  summary,
  activeMetric,
  locale,
  onSelectMetric,
}: {
  summary: AgentTokenUsageSummary;
  activeMetric: "hit" | "tokens";
  locale: string;
  onSelectMetric: (metric: "hit" | "tokens") => void;
}) {
  return (
    <div className="grid grid-cols-2 divide-x divide-secondary border-b border-secondary">
      <Tooltip title={m.agent_usage_cache_hit_rate()} description={m.agent_usage_cache_hit_help()}>
        <AriaButton
          aria-pressed={activeMetric === "hit"}
          onPress={() => onSelectMetric("hit")}
          className={cn(
            "relative flex min-h-11 min-w-0 cursor-pointer flex-col items-start px-3.5 py-3.5 text-left outline-none transition-colors data-focus-visible:ring-2 data-focus-visible:ring-inset data-focus-visible:ring-brand",
            activeMetric === "hit" ? "bg-secondary" : "bg-primary hover:bg-primary_hover",
          )}
        >
          <span className="flex w-full min-w-0 items-center gap-1 text-xs text-tertiary">
            <span className="truncate">{m.agent_usage_cache_hit_rate()}</span>
            <HelpCircle className="size-3 shrink-0 opacity-75" aria-hidden="true" />
          </span>
          <span
            className={cn(
              "mt-1.5 font-mono text-2xl font-bold leading-none tracking-tight tabular-nums",
              summary.cacheHitPercent !== null ? "text-success-primary" : "text-quaternary",
            )}
          >
            {summary.cacheHitPercent !== null
              ? formatUsagePercent(summary.cacheHitPercent, locale)
              : "—"}
          </span>
          <span className="mt-1.5 w-full truncate text-xs tabular-nums text-tertiary">
            {m.agent_usage_cache_read_summary({
              tokens: formatCompactTokens(summary.cacheReadTokens, locale),
            })}
          </span>
          {activeMetric === "hit" && (
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-fg-primary" />
          )}
        </AriaButton>
      </Tooltip>

      <Tooltip title={formatExactTokens(summary.effectiveTokens, locale)}>
        <AriaButton
          aria-pressed={activeMetric === "tokens"}
          onPress={() => onSelectMetric("tokens")}
          className={cn(
            "relative flex min-h-11 min-w-0 cursor-pointer flex-col items-start px-3.5 py-3.5 text-left outline-none transition-colors data-focus-visible:ring-2 data-focus-visible:ring-inset data-focus-visible:ring-brand",
            activeMetric === "tokens" ? "bg-secondary" : "bg-primary hover:bg-primary_hover",
          )}
        >
          <span className="w-full truncate text-xs text-tertiary">
            {m.agent_usage_tokens_used()}
          </span>
          <span className="mt-1.5 font-mono text-2xl font-bold leading-none tracking-tight tabular-nums text-primary">
            {formatCompactTokens(summary.effectiveTokens, locale)}
          </span>
          <span className="mt-1.5 w-full truncate text-xs tabular-nums text-tertiary">
            {m.agent_usage_input_output_summary({
              input: formatCompactTokens(summary.newInputTokens, locale),
              output: formatCompactTokens(summary.outputTokens, locale),
            })}
          </span>
          {activeMetric === "tokens" && (
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-fg-primary" />
          )}
        </AriaButton>
      </Tooltip>
    </div>
  );
}

export function UsageAllRuntimesHeader({
  summary,
  locale,
  onSelectRuntime,
}: {
  summary: AgentTokenUsageSummary;
  locale: string;
  onSelectRuntime: (provider: string) => void;
}) {
  return (
    <div className="space-y-2.5 border-b border-secondary bg-secondary px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-tertiary">{m.agent_usage_by_runtime_hit_title()}</span>
        <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-primary">
          {m.agent_usage_tokens_summary({
            tokens: formatCompactTokens(summary.effectiveTokens, locale),
          })}
        </span>
      </div>
      {summary.runtimes.length === 0 ? (
        <p className="font-mono text-xs text-quaternary">—</p>
      ) : (
        <div
          className={cn(
            "grid gap-2",
            summary.runtimes.length === 2 ? "grid-cols-2" : "grid-cols-3",
          )}
        >
          {summary.runtimes.map((runtime) => (
            <AriaButton
              key={runtime.provider}
              onPress={() => onSelectRuntime(runtime.provider)}
              className="flex min-h-11 min-w-0 cursor-pointer flex-col items-start rounded-lg border border-secondary bg-primary px-2.5 py-2 text-left outline-none transition-colors hover:bg-primary_hover data-focus-visible:ring-2 data-focus-visible:ring-brand"
            >
              <span className="flex w-full min-w-0 items-center gap-1 text-xs text-tertiary">
                {runtime.isCurrent && (
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-success-solid"
                  />
                )}
                <span className="truncate">{runtimeProviderDisplayName(runtime.provider)}</span>
              </span>
              <span
                className={cn(
                  "mt-0.5 font-mono text-lg font-bold leading-tight tabular-nums",
                  runtime.cacheHitPercent !== null ? "text-success-primary" : "text-quaternary",
                )}
              >
                {runtime.cacheHitPercent !== null
                  ? formatUsagePercent(runtime.cacheHitPercent, locale)
                  : "—"}
              </span>
              <span className="font-mono text-xs tabular-nums text-tertiary">
                {formatCompactTokens(runtime.effectiveTokens, locale)}
              </span>
            </AriaButton>
          ))}
        </div>
      )}
    </div>
  );
}
