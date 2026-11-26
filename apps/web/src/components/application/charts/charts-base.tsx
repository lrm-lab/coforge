import type { ReactNode } from "react";
import type { TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { cx } from "#src/utils/cx";

export interface ChartTooltipContentProps
  extends Partial<TooltipContentProps<ValueType, NameType>> {
  isPieChart?: boolean;
  isRadialChart?: boolean;
  className?: string;
}

function readPayloadColor(entry: {
  color?: string;
  fill?: string;
  payload?: unknown;
}): string | undefined {
  if (entry.color) return entry.color;
  if (entry.fill) return entry.fill;
  if (entry.payload && typeof entry.payload === "object" && "fill" in entry.payload) {
    const nested = (entry.payload as { fill?: unknown }).fill;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  formatter,
  labelFormatter,
  isPieChart = false,
  isRadialChart = false,
  className,
}: ChartTooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;

  if (isPieChart || isRadialChart) {
    const entry = payload[0];
    if (!entry) return null;
    const rawValue = entry.value as ValueType | undefined;
    const rawName = entry.name as NameType | undefined;
    const formatted =
      formatter && rawValue !== undefined && rawName !== undefined
        ? formatter(rawValue, rawName, entry, 0, payload)
        : undefined;
    const [displayValue, displayName]: [ReactNode, ReactNode] = Array.isArray(formatted)
      ? [formatted[0], formatted[1]]
      : [formatted ?? (rawValue !== undefined ? String(rawValue) : ""), rawName ?? ""];
    const titleNode = labelFormatter ? labelFormatter(displayName, payload) : displayName;
    const swatchColor = readPayloadColor(entry);

    return (
      <div
        className={cx(
          "pointer-events-none flex max-w-[min(15rem,calc(100vw-1.5rem))] flex-col gap-1 rounded-lg bg-primary-solid px-3 py-2 shadow-lg ring-1 ring-secondary_alt",
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {swatchColor && (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: swatchColor }}
            />
          )}
          <span className="min-w-0 truncate text-xs font-semibold text-white">{titleNode}</span>
        </div>
        <span className="whitespace-nowrap font-mono text-xs font-medium text-tooltip-supporting-text tabular-nums">
          {displayValue}
        </span>
      </div>
    );
  }

  const headerNode =
    labelFormatter && label !== undefined
      ? labelFormatter(label, payload)
      : label !== undefined
        ? String(label)
        : null;

  return (
    <div
      className={cx(
        "pointer-events-none flex max-w-[min(16rem,calc(100vw-1.5rem))] flex-col gap-1.5 rounded-lg bg-primary-solid px-3 py-2 shadow-lg ring-1 ring-secondary_alt",
        className,
      )}
    >
      {headerNode !== null && headerNode !== "" && (
        <span className="truncate text-xs font-semibold text-white">{headerNode}</span>
      )}
      <div className="flex flex-col gap-1">
        {payload.map((entry, index) => {
          const rawValue = entry.value as ValueType | undefined;
          const rawName = entry.name as NameType | undefined;
          const formatted =
            formatter && rawValue !== undefined && rawName !== undefined
              ? formatter(rawValue, rawName, entry, index, payload)
              : undefined;
          const [displayValue, displayName]: [ReactNode, ReactNode] = Array.isArray(formatted)
            ? [formatted[0], formatted[1]]
            : [formatted ?? (rawValue !== undefined ? String(rawValue) : ""), rawName ?? ""];
          const swatchColor = readPayloadColor(entry);

          return (
            <div
              key={`${String(entry.dataKey ?? rawName ?? index)}-${index}`}
              className="flex min-w-0 items-center justify-between gap-3 text-xs"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-tooltip-supporting-text">
                {swatchColor && (
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: swatchColor }}
                  />
                )}
                <span className="truncate">{displayName}</span>
              </span>
              <span className="shrink-0 font-mono font-semibold text-white tabular-nums">
                {displayValue}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
