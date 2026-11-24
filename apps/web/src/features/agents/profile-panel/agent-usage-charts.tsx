import { useMemo } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import {
  formatCompactTokens,
  heatmapLevel,
  type AgentTokenUsageBucket,
} from "#src/features/agents/agent-token-usage-model";
import { dateTimeFormat } from "#src/lib/dates";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

function shortWeekday(dateKey: string, locale: string): string {
  const date = Temporal.PlainDate.from(dateKey);
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
  return dateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(utc);
}

function monthDay(dateKey: string): string {
  const date = Temporal.PlainDate.from(dateKey);
  return `${date.month}/${date.day}`;
}

function dayNumber(dateKey: string): number {
  return Temporal.PlainDate.from(dateKey).day;
}

function weekdayHeaders(locale: string): string[] {
  const monday = Temporal.PlainDate.from("2026-11-16");
  return Array.from({ length: 7 }, (_, i) => {
    const d = monday.add({ days: i });
    const utc = new Date(Date.UTC(d.year, d.month - 1, d.day, 12));
    return dateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" }).format(utc);
  });
}

function barHeightPercent(value: number, peak: number): number {
  if (value <= 0 || peak <= 0) return 0;
  return Math.max(8, Math.round((value / peak) * 100));
}

export function TodayHourlyChart({
  buckets,
  peak,
  selectedKey,
  onToggleSelect,
}: {
  buckets: readonly AgentTokenUsageBucket[];
  peak: number;
  selectedKey: string | null;
  onToggleSelect: (key: string) => void;
}) {
  const locale = getLocale();
  const peakBucket = useMemo(
    () => buckets.find((b) => peak > 0 && b.effectiveTokens === peak) ?? null,
    [buckets, peak],
  );
  return (
    <div className="mt-4">
      <div
        role="group"
        aria-label={m.agent_usage_hourly_label()}
        className="grid h-20 grid-cols-24 items-end gap-0.5 border-b border-secondary pb-1"
      >
        {buckets.map((bucket) => {
          const selected = selectedKey === bucket.key;
          const heightPct = barHeightPercent(bucket.effectiveTokens, peak);
          const hourLabel = `${bucket.key}:00`;
          const valLabel = formatCompactTokens(bucket.effectiveTokens, locale);
          return (
            <Tooltip key={bucket.key} title={`${hourLabel} ${valLabel}`}>
              <AriaButton
                aria-pressed={selected}
                aria-label={`${hourLabel} ${valLabel}`}
                onPress={() => onToggleSelect(bucket.key)}
                className={cn(
                  "group flex h-full min-w-0 cursor-pointer flex-col items-center justify-end rounded-xs outline-none transition-colors data-focus-visible:ring-2 data-focus-visible:ring-brand",
                  selected ? "bg-secondary" : "hover:bg-primary_hover",
                )}
              >
                {heightPct > 0 ? (
                  <span
                    className={cn(
                      "block w-full rounded-t-xs transition-opacity",
                      selected
                        ? "bg-chart-input opacity-100"
                        : selectedKey !== null
                          ? "bg-chart-input opacity-30 group-hover:opacity-75"
                          : "bg-chart-input/85 group-hover:bg-chart-input",
                    )}
                    style={{ height: `${heightPct}%` }}
                  />
                ) : (
                  <span className="block h-0.5 w-full rounded-full bg-chart-slot" />
                )}
              </AriaButton>
            </Tooltip>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between font-mono text-xs tabular-nums text-quaternary">
        <span>00:00</span>
        <span>06:00</span>
        <span>
          {peakBucket
            ? `${peakBucket.key}:00 ${m.agent_usage_peak_label({ value: formatCompactTokens(peakBucket.effectiveTokens, locale) })}`
            : "12:00"}
        </span>
        <span>18:00</span>
        <span>23:00</span>
      </div>
    </div>
  );
}

export function DailyBarChart({
  buckets,
  peak,
  selectedKey,
  onToggleSelect,
}: {
  buckets: readonly AgentTokenUsageBucket[];
  peak: number;
  selectedKey: string | null;
  onToggleSelect: (key: string) => void;
}) {
  const locale = getLocale();
  const compact = buckets.length > 7;
  return (
    <div className="mt-4">
      <div className="relative">
        {peak > 0 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-5 border-t border-dashed border-secondary"
          />
        )}
        <div
          role="group"
          aria-label={m.agent_usage_daily_label()}
          className={cn(
            "relative grid items-end",
            compact ? "grid-cols-14 gap-1" : "grid-cols-7 gap-1.5",
          )}
        >
          {buckets.map((bucket) => {
            const selected = selectedKey === bucket.key;
            const heightPct = barHeightPercent(bucket.effectiveTokens, peak);
            const valLabel = formatCompactTokens(bucket.effectiveTokens, locale);
            const showValue = !compact
              ? bucket.effectiveTokens > 0
              : peak > 0 && bucket.effectiveTokens === peak;
            const dayLabel = bucket.isCurrent
              ? m.agent_usage_today_short()
              : shortWeekday(bucket.dateKey, locale);
            const dateLabel = monthDay(bucket.dateKey);
            return (
              <Tooltip key={bucket.key} title={`${dateLabel} ${valLabel}`}>
                <AriaButton
                  aria-pressed={selected}
                  aria-label={`${dateLabel} ${valLabel}`}
                  onPress={() => onToggleSelect(bucket.key)}
                  className={cn(
                    "group flex min-w-0 cursor-pointer flex-col items-center rounded-md px-0.5 py-1 outline-none transition-colors data-focus-visible:ring-2 data-focus-visible:ring-brand",
                    selected ? "bg-secondary" : "hover:bg-primary_hover",
                  )}
                >
                  <span className="flex h-4 items-end justify-center font-mono text-xs leading-none tabular-nums text-tertiary">
                    {showValue ? (
                      <span className={cn("truncate", selected && "font-semibold text-primary")}>
                        {valLabel}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 flex h-16 w-full items-end justify-center">
                    {heightPct > 0 ? (
                      <span
                        className={cn(
                          "block rounded-t-xs transition-opacity",
                          compact ? "w-full max-w-3.5" : "w-full max-w-6",
                          selected
                            ? "bg-chart-input opacity-100"
                            : selectedKey !== null
                              ? "bg-chart-input opacity-30 group-hover:opacity-75"
                              : "bg-chart-input/85 group-hover:bg-chart-input",
                        )}
                        style={{ height: `${heightPct}%` }}
                      />
                    ) : (
                      <span
                        className={cn(
                          "block h-[0.1875rem] rounded-full bg-chart-slot",
                          compact ? "w-full max-w-3.5" : "w-full max-w-6",
                        )}
                      />
                    )}
                  </span>
                  {!compact && (
                    <span className="mt-1.5 flex min-w-0 flex-col items-center leading-tight">
                      <span
                        className={cn(
                          "truncate text-xs",
                          selected ? "font-semibold text-primary" : "text-secondary",
                        )}
                      >
                        {dayLabel}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-quaternary">
                        {dateLabel}
                      </span>
                    </span>
                  )}
                </AriaButton>
              </Tooltip>
            );
          })}
        </div>
      </div>
      {compact && buckets.length > 0 && (
        <div className="mt-1.5 flex items-center justify-between font-mono text-xs tabular-nums text-quaternary">
          <span>{monthDay(buckets[0]!.dateKey)}</span>
          <span>{monthDay(buckets[Math.floor(buckets.length / 2)]!.dateKey)}</span>
          <span>{m.agent_usage_today_short()}</span>
        </div>
      )}
    </div>
  );
}

const HEAT_CELL_CLASS = {
  0: "bg-secondary text-quaternary",
  1: "bg-chart-heat-1 text-primary",
  2: "bg-chart-heat-2 text-primary font-medium",
  3: "bg-chart-heat-3 text-white font-medium",
  4: "bg-chart-heat-4 text-white font-semibold",
} as const;

export function CalendarHeatmapChart({
  buckets,
  peak,
  selectedKey,
  onToggleSelect,
}: {
  buckets: readonly AgentTokenUsageBucket[];
  peak: number;
  selectedKey: string | null;
  onToggleSelect: (key: string) => void;
}) {
  const locale = getLocale();
  const headers = useMemo(() => weekdayHeaders(locale), [locale]);
  const leadingEmpty = buckets[0]?.dayOfWeek ? buckets[0].dayOfWeek - 1 : 0;

  return (
    <div className="mt-4">
      <div className="grid grid-cols-7 gap-1.5">
        {headers.map((label, idx) => (
          <span key={idx} aria-hidden="true" className="pb-0.5 text-center text-xs text-quaternary">
            {label}
          </span>
        ))}
      </div>
      <div
        role="group"
        aria-label={m.agent_usage_calendar_label()}
        className="mt-1 grid grid-cols-7 gap-1.5"
      >
        {Array.from({ length: leadingEmpty }, (_, i) => (
          <span key={`pad-${i}`} aria-hidden="true" />
        ))}
        {buckets.map((bucket) => {
          const selected = selectedKey === bucket.key;
          const level = heatmapLevel(bucket.effectiveTokens, peak);
          const dateLabel = monthDay(bucket.dateKey);
          const valLabel = formatCompactTokens(bucket.effectiveTokens, locale);
          return (
            <Tooltip key={bucket.key} title={`${dateLabel} ${valLabel}`}>
              <AriaButton
                aria-pressed={selected}
                aria-label={`${dateLabel} ${valLabel}`}
                onPress={() => onToggleSelect(bucket.key)}
                className={cn(
                  "flex h-7 min-w-0 cursor-pointer items-center justify-center rounded-sm font-mono text-xs tabular-nums outline-none transition-opacity data-focus-visible:ring-2 data-focus-visible:ring-brand",
                  HEAT_CELL_CLASS[level],
                  selectedKey !== null && !selected && "opacity-40 hover:opacity-80",
                  bucket.isCurrent && !selected && "ring-1 ring-inset ring-primary",
                  selected && "ring-2 ring-inset ring-brand",
                )}
              >
                {dayNumber(bucket.dateKey)}
              </AriaButton>
            </Tooltip>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-quaternary">{m.agent_usage_calendar_hint()}</p>
    </div>
  );
}

export function InlineSparkline({
  values,
  strokeClassName,
  fillClassName,
  selectedIndex,
}: {
  values: readonly number[];
  strokeClassName: string;
  fillClassName: string;
  selectedIndex: number | null;
}) {
  const { path, activePoint } = useMemo(() => {
    const count = values.length;
    if (count === 0) return { path: "", activePoint: null };
    const max = Math.max(...values, 0);
    const width = 112;
    const height = 18;
    const padX = 2;
    const padY = 2;
    const innerW = width - padX * 2;
    const innerH = height - padY * 2;
    const coords = values.map((v, i) => {
      const x = count === 1 ? width / 2 : padX + (i / (count - 1)) * innerW;
      const y = max > 0 ? padY + innerH - (v / max) * innerH : height - padY;
      return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    });
    const d = coords.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    const active =
      selectedIndex !== null && selectedIndex >= 0 && selectedIndex < coords.length
        ? coords[selectedIndex]!
        : null;
    return { path: d, activePoint: active };
  }, [values, selectedIndex]);

  if (!path) return null;
  return (
    <svg aria-hidden="true" viewBox="0 0 112 18" className="h-4.5 w-full max-w-28 overflow-visible">
      <path
        d={path}
        fill="none"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={strokeClassName}
      />
      {activePoint && (
        <circle cx={activePoint.x} cy={activePoint.y} r="2.75" className={fillClassName} />
      )}
    </svg>
  );
}
