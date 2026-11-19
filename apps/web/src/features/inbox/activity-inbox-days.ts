import { useEffect, useMemo, useState } from "react";
import { useHydrated } from "@tanstack/react-router";

import { dateTimeFormat } from "#src/lib/dates";
import { useRenderClock, useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

export function useActivityDays<T>(items: T[], at: (item: T) => string | Date) {
  const hydrated = useHydrated();
  const render = useRenderClock();
  const zone = useTimeZone();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return useMemo(
    () => (hydrated ? groupByDay(items, at, zone, now) : renderDays(items, at, render)),
    [hydrated, items, at, zone, now, render],
  );
}

export function renderDays<T>(
  items: T[],
  at: (item: T) => string | Date,
  render: { zone: string | undefined; renderedAt: number },
) {
  return render.zone
    ? groupByDay(items, at, render.zone, render.renderedAt)
    : [{ key: "all", label: undefined, items }];
}

export function daySectionKey(index: number, dayKey: string) {
  return index === 0 ? "days" : dayKey;
}

export function groupByDay<T>(
  items: T[],
  at: (item: T) => string | Date,
  zone: string,
  now: number,
) {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).toPlainDate();
  const groups = new Map<string, { key: string; label: string | undefined; items: T[] }>();
  for (const item of items) {
    const raw = at(item);
    const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
    const date = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDate();
    const key = date.toString();
    const group = groups.get(key) ?? { key, label: dayName(date, today), items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function dayName(date: Temporal.PlainDate, today: Temporal.PlainDate) {
  const ago = date.until(today, { largestUnit: "day" }).days;
  if (ago <= 0) return m.activity_inbox_today();
  if (ago === 1) return m.activity_inbox_yesterday();
  return dateTimeFormat(getLocale(), {
    ...(date.year === today.year ? { weekday: "long" } : { year: "numeric" }),
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day)));
}
