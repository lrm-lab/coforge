import { Suspense, lazy, useId, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { formatNumber } from "#src/lib/format-number";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

import {
  formatCompactTokens,
  formatUsagePercent,
  type AgentTokenUsageModelShare,
} from "./agent-token-usage-model";
import {
  WORKSPACE_MODEL_DONUT_PRIMARY_LIMIT,
  summarizeModelDistribution,
  type ModelDistributionSlice,
  type ModelDistributionSliceTone,
} from "./workspace-agent-usage-model";
import type { ModelDonutChartDatum } from "./workspace-agent-usage-model-donut-chart";

const LazyDonutChart = lazy(() => import("./workspace-agent-usage-model-donut-chart"));

const SLICE_FILL_VAR: Record<ModelDistributionSliceTone, string> = {
  "rank-1": "var(--color-chart-input)",
  "rank-2": "var(--color-chart-output)",
  "rank-3": "var(--color-chart-series-3)",
  "rank-4": "var(--color-chart-cache)",
  other: "var(--color-chart-other)",
};

const SLICE_SWATCH_CLASS: Record<ModelDistributionSliceTone, string> = {
  "rank-1": "bg-chart-input",
  "rank-2": "bg-chart-output",
  "rank-3": "bg-chart-series-3",
  "rank-4": "bg-chart-cache",
  other: "bg-chart-other",
};

const COARSE_HIT_TARGET_CLASS =
  "relative any-pointer-coarse:after:absolute any-pointer-coarse:after:top-1/2 any-pointer-coarse:after:left-1/2 any-pointer-coarse:after:size-full any-pointer-coarse:after:min-h-11 any-pointer-coarse:after:min-w-11 any-pointer-coarse:after:-translate-x-1/2 any-pointer-coarse:after:-translate-y-1/2";

function sliceDisplayLabel(slice: ModelDistributionSlice, locale: string): string {
  if (slice.kind === "other") {
    return m.agent_usage_models_other({ count: formatNumber(slice.otherCount, locale) });
  }
  return slice.model || m.agent_usage_model_unknown();
}

function DonutPlotFallback() {
  return (
    <div aria-hidden="true" className="flex size-full items-center justify-center p-1">
      <Skeleton className="size-full rounded-full" />
    </div>
  );
}

export function WorkspaceAgentUsageModelDonutCard({
  models,
  locale,
}: {
  models: readonly AgentTokenUsageModelShare[];
  locale: string;
}) {
  const fullListId = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  const distribution = useMemo(() => summarizeModelDistribution(models), [models]);

  const chartData = useMemo<readonly ModelDonutChartDatum[]>(
    () =>
      distribution.slices.map((slice) => ({
        key: slice.key,
        label: sliceDisplayLabel(slice, locale),
        effectiveTokens: slice.effectiveTokens,
        sharePercent: slice.sharePercent,
        fill: SLICE_FILL_VAR[slice.tone],
      })),
    [distribution.slices, locale],
  );

  if (distribution.slices.length === 0) return null;

  const hasOverflowModels = distribution.otherModels.length > 0;
  const activeSlice =
    activeIndex !== null && activeIndex >= 0 && activeIndex < distribution.slices.length
      ? distribution.slices[activeIndex]!
      : null;

  return (
    <section className="@container/donut flex min-w-0 flex-col justify-between overflow-hidden rounded-xl border border-secondary bg-primary p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-tertiary">
          {m.agent_usage_team_models_heading()}
        </h2>
        {hasOverflowModels && (
          <Button
            size="xs"
            color="link-gray"
            iconTrailing={expanded ? ChevronUp : ChevronDown}
            aria-expanded={expanded}
            aria-controls={fullListId}
            onPress={() => setExpanded((prev) => !prev)}
            className={cn("shrink-0 text-xs font-medium", COARSE_HIT_TARGET_CLASS)}
          >
            {expanded
              ? m.agent_usage_models_show_less()
              : m.agent_usage_models_show_all({
                  count: formatNumber(distribution.totalModelCount, locale),
                })}
          </Button>
        )}
      </div>

      <div className="mt-3 flex flex-1 flex-col items-center gap-4 @[24rem]/donut:flex-row @[24rem]/donut:items-center @[24rem]/donut:gap-5">
        <div className="relative size-36 shrink-0" onMouseLeave={() => setActiveIndex(null)}>
          <Suspense fallback={<DonutPlotFallback />}>
            <LazyDonutChart
              data={chartData}
              activeIndex={activeIndex}
              onActiveIndexChange={setActiveIndex}
              locale={locale}
            />
          </Suspense>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-3 text-center">
            {activeSlice ? (
              <>
                <span className="max-w-full truncate font-mono text-base font-bold leading-tight tracking-tight text-primary tabular-nums">
                  {formatUsagePercent(activeSlice.sharePercent, locale)}
                </span>
                <span className="mt-0.5 max-w-full truncate font-mono text-xs leading-tight text-tertiary tabular-nums">
                  {formatCompactTokens(activeSlice.effectiveTokens, locale)}
                </span>
              </>
            ) : (
              <>
                <span className="max-w-full truncate font-mono text-lg font-bold leading-tight tracking-tight text-primary tabular-nums">
                  {formatNumber(distribution.totalModelCount, locale)}
                </span>
                <span className="mt-0.5 max-w-full truncate text-xs leading-tight text-tertiary">
                  {distribution.totalModelCount === 1
                    ? m.agent_usage_models_center_one()
                    : m.agent_usage_models_center_other()}
                </span>
              </>
            )}
          </div>
        </div>

        <ul
          aria-label={m.agent_usage_team_models_heading()}
          className="flex w-full min-w-0 flex-1 flex-col gap-1"
          onMouseLeave={() => setActiveIndex(null)}
        >
          {distribution.slices.map((slice, index) => {
            const label = sliceDisplayLabel(slice, locale);
            const highlighted = activeIndex === index;
            const dimmed = activeIndex !== null && !highlighted;
            const rowClass = cn(
              "flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs transition-colors",
              highlighted ? "bg-primary_hover" : "hover:bg-primary_hover",
              dimmed && "opacity-50",
            );

            const rowInner = (
              <>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn("size-2 shrink-0 rounded-full", SLICE_SWATCH_CLASS[slice.tone])}
                  />
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      slice.kind === "other"
                        ? "font-medium text-secondary"
                        : "font-mono text-primary",
                    )}
                  >
                    {label}
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-2 font-mono tabular-nums">
                  <span className="whitespace-nowrap text-tertiary">
                    {formatCompactTokens(slice.effectiveTokens, locale)}
                  </span>
                  <span className="min-w-12 text-end font-semibold whitespace-nowrap text-primary">
                    {formatUsagePercent(slice.sharePercent, locale)}
                  </span>
                </span>
              </>
            );

            if (slice.kind === "other") {
              return (
                <li key={slice.key} className="min-w-0">
                  <AriaButton
                    aria-expanded={expanded}
                    aria-controls={fullListId}
                    onPress={() => setExpanded((prev) => !prev)}
                    onHoverChange={(hovering) => setActiveIndex(hovering ? index : null)}
                    onFocusChange={(focused) => setActiveIndex(focused ? index : null)}
                    className={cn(
                      rowClass,
                      "cursor-pointer text-start outline-none data-focus-visible:ring-2 data-focus-visible:ring-brand",
                      COARSE_HIT_TARGET_CLASS,
                    )}
                  >
                    {rowInner}
                  </AriaButton>
                </li>
              );
            }

            return (
              <li
                key={slice.key}
                tabIndex={0}
                className={cn(
                  rowClass,
                  "outline-none focus-visible:ring-2 focus-visible:ring-brand",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              >
                {rowInner}
              </li>
            );
          })}
        </ul>
      </div>

      {hasOverflowModels && expanded && (
        <div id={fullListId} className="mt-3 border-t border-secondary pt-3">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-tertiary">
            <span className="font-medium">{m.agent_usage_models_all_heading()}</span>
            <span className="font-mono tabular-nums">
              {formatNumber(distribution.totalModelCount, locale)}
            </span>
          </div>
          <ul
            aria-label={m.agent_usage_models_all_heading()}
            className="flex max-h-56 flex-col gap-0.5 overflow-y-auto"
            onMouseLeave={() => setActiveIndex(null)}
          >
            {distribution.allModels.map((entry, index) => {
              const targetSliceIndex = Math.min(index, WORKSPACE_MODEL_DONUT_PRIMARY_LIMIT);
              const highlighted = activeIndex === targetSliceIndex;
              return (
                <li
                  key={entry.key}
                  onMouseEnter={() => setActiveIndex(targetSliceIndex)}
                  onMouseLeave={() => setActiveIndex(null)}
                  className={cn(
                    "flex min-w-0 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs transition-colors",
                    highlighted ? "bg-primary_hover" : "hover:bg-primary_hover",
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn("size-2 shrink-0 rounded-full", SLICE_SWATCH_CLASS[entry.tone])}
                    />
                    <span className="min-w-0 truncate font-mono text-primary">
                      {entry.model || m.agent_usage_model_unknown()}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2 font-mono tabular-nums">
                    <span className="text-tertiary">
                      {formatCompactTokens(entry.effectiveTokens, locale)}
                    </span>
                    <span className="w-11 text-right font-semibold text-primary">
                      {formatUsagePercent(entry.sharePercent, locale)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
