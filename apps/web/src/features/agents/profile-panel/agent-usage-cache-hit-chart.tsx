import { useEffect, useId, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import type { TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { ChartTooltipContent } from "#src/components/application/charts/charts-base";
import {
  formatCompactTokens,
  formatUsagePercent,
} from "#src/features/agents/agent-token-usage-model";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { createChartHoverController, type ChartHoverController } from "#src/lib/hover-intent";
import { m } from "#src/paraglide/messages";

export type CacheHitChartDatum = Readonly<{
  key: string;
  label: string;
  tooltipLabel: string;
  hitPercent: number | null;
  cacheReadTokens: number;
}>;

export default function AgentUsageCacheHitChart({
  data,
  locale,
}: {
  data: readonly CacheHitChartDatum[];
  locale: string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const prefersReducedMotion = usePrefersReducedMotion();
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const hoverControllerRef = useRef<ChartHoverController | null>(null);
  const hasAnyPoint = data.some((point) => point.hitPercent !== null);

  useEffect(() => {
    const controller = createChartHoverController({ onChange: setTooltipVisible });
    hoverControllerRef.current = controller;
    return () => {
      controller.dispose();
      if (hoverControllerRef.current === controller) {
        hoverControllerRef.current = null;
      }
    };
  }, []);

  if (!hasAnyPoint) {
    return (
      <div className="flex h-60 items-center justify-center rounded-lg border border-dashed border-secondary font-mono text-xs text-quaternary">
        —
      </div>
    );
  }

  const chartData = [...data];

  function renderTooltip(props: TooltipContentProps<ValueType, NameType>) {
    if (!tooltipVisible) return null;
    const first = props.payload?.[0];
    if (!first || first.value === null || first.value === undefined) return null;
    const datum = first.payload as CacheHitChartDatum | undefined;
    return (
      <ChartTooltipContent
        {...props}
        labelFormatter={() => datum?.tooltipLabel ?? String(props.label ?? "")}
        formatter={(value) => {
          const numeric = typeof value === "number" ? value : Number(value);
          const pct = formatUsagePercent(numeric, locale);
          const cacheNote = datum
            ? m.agent_usage_cache_read_summary({
                tokens: formatCompactTokens(datum.cacheReadTokens, locale),
              })
            : m.agent_usage_cache_hit_rate();
          return [pct, cacheNote];
        }}
      />
    );
  }

  return (
    <div
      className="h-60 w-full"
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") {
          setTooltipVisible(true);
          return;
        }
        hoverControllerRef.current?.pointerEnter();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        hoverControllerRef.current?.pointerLeave();
      }}
    >
      <AreaChart
        responsive
        data={chartData}
        className="size-full"
        margin={{ top: 8, right: 16, bottom: 0, left: 4 }}
        role="img"
        aria-label={m.agent_usage_hit_chart_label()}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-chart-input)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--color-chart-input)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid
          vertical={false}
          strokeDasharray="2 3"
          stroke="var(--color-border-secondary)"
        />
        <XAxis
          dataKey="label"
          axisLine={{ stroke: "var(--color-border-secondary)" }}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={20}
          tick={{
            fontSize: 11,
            fill: "var(--color-text-quaternary)",
            fontFamily: "var(--font-mono)",
          }}
        />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 50, 100]}
          width={36}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value: number) => `${value}%`}
          tick={{
            fontSize: 11,
            fill: "var(--color-text-quaternary)",
            fontFamily: "var(--font-mono)",
          }}
        />
        <RechartsTooltip
          content={renderTooltip}
          isAnimationActive={!prefersReducedMotion}
          animationDuration={140}
          cursor={{ stroke: "var(--color-border-primary)", strokeDasharray: "2 3" }}
          wrapperStyle={{ zIndex: 20, pointerEvents: "none" }}
        />
        <Area
          type="monotone"
          dataKey="hitPercent"
          name={m.agent_usage_cache_hit_rate()}
          stroke="var(--color-chart-input)"
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          connectNulls
          dot={{ r: 2.5, fill: "var(--color-chart-input)", strokeWidth: 0 }}
          activeDot={{
            r: 4,
            fill: "var(--color-chart-input)",
            stroke: "var(--color-bg-primary)",
            strokeWidth: 1.5,
          }}
          isAnimationActive={!prefersReducedMotion}
          animationDuration={220}
          animationEasing="ease-out"
        />
      </AreaChart>
    </div>
  );
}
