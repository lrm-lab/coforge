import { useEffect, useRef, useState } from "react";
import { Pie, PieChart, Sector, Tooltip as RechartsTooltip } from "recharts";
import type { PieSectorShapeProps, TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { ChartTooltipContent } from "#src/components/application/charts/charts-base";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { createChartHoverController, type ChartHoverController } from "#src/lib/hover-intent";
import { m } from "#src/paraglide/messages";
import { formatExactTokens, formatUsagePercent } from "./agent-token-usage-model";

export type ModelDonutChartDatum = Readonly<{
  key: string;
  label: string;
  effectiveTokens: number;
  sharePercent: number;
  fill: string;
}>;

type DonutSectorProps = PieSectorShapeProps & {
  activeSliceIndex: number | null;
};

function DonutSector({ activeSliceIndex, ...props }: DonutSectorProps) {
  const isHighlighted = activeSliceIndex === props.index || props.isActive;
  const isDimmed = activeSliceIndex !== null && !isHighlighted;
  const outerRadius = props.outerRadius ?? 0;

  return (
    <Sector
      cx={props.cx}
      cy={props.cy}
      innerRadius={props.innerRadius}
      outerRadius={isHighlighted ? outerRadius + 3 : outerRadius}
      startAngle={props.startAngle}
      endAngle={props.endAngle}
      cornerRadius={props.cornerRadius}
      fill={props.fill}
      fillOpacity={isDimmed ? 0.32 : 1}
      stroke="none"
      className="cursor-pointer outline-none transition-opacity duration-150"
    />
  );
}

export default function ModelDistributionDonutChart({
  data,
  activeIndex,
  onActiveIndexChange,
  locale,
}: {
  data: readonly ModelDonutChartDatum[];
  activeIndex: number | null;
  onActiveIndexChange: (index: number | null) => void;
  locale: string;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const hoverControllerRef = useRef<ChartHoverController | null>(null);
  const multiSlice = data.length > 1;
  const chartData = [...data];

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

  function renderSector(props: PieSectorShapeProps) {
    return <DonutSector {...props} activeSliceIndex={activeIndex} />;
  }

  function renderTooltip(props: TooltipContentProps<ValueType, NameType>) {
    if (!tooltipVisible) return null;
    return (
      <ChartTooltipContent
        {...props}
        isPieChart
        formatter={(value, name, item) => {
          const datum = item.payload as ModelDonutChartDatum | undefined;
          const numeric = typeof value === "number" ? value : Number(value);
          const percent = datum ? formatUsagePercent(datum.sharePercent, locale) : "";
          const formatted = m.agent_usage_models_tooltip_tokens({
            exact: formatExactTokens(numeric, locale),
            percent,
          });
          return [formatted, String(name)];
        }}
      />
    );
  }

  return (
    <div
      className="size-full"
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
      <PieChart
        responsive
        className="size-full"
        margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
        role="img"
        aria-label={m.agent_usage_models_chart_label()}
      >
        <Pie
          data={chartData}
          dataKey="effectiveTokens"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius="66%"
          outerRadius="92%"
          startAngle={90}
          endAngle={-270}
          paddingAngle={multiSlice ? 2 : 0}
          cornerRadius={multiSlice ? 3 : 0}
          minAngle={multiSlice ? 4 : 0}
          stroke="none"
          rootTabIndex={-1}
          isAnimationActive={!prefersReducedMotion}
          animationBegin={0}
          animationDuration={450}
          shape={renderSector}
          onMouseEnter={(_, index) => onActiveIndexChange(index)}
        />
        <RechartsTooltip
          content={renderTooltip}
          allowEscapeViewBox={{ x: true, y: true }}
          isAnimationActive={!prefersReducedMotion}
          animationDuration={140}
          wrapperStyle={{ zIndex: 20, pointerEvents: "none" }}
        />
      </PieChart>
    </div>
  );
}
