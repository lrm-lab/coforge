import { useEffect, useState } from "react";
import { useHydrated } from "@tanstack/react-router";

import { dateTimeFormat } from "#src/lib/dates";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

/**
 * The days an Activity list falls on, newest first: each item goes under the day of its latest
 * message, in the viewer's time zone. Before
 * hydration there is no zone to name a day in, so the whole list is one group and no heading shows
 * (the server and the first client render agree).
 */
export function useActivityDays<T>(items: T[], at: (item: T) => string | Date) {
  const hydrated = useHydrated();
  const zone = useTimeZone();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!hydrated) return [{ key: "all", label: undefined, items }];
  return groupByDay(items, at, zone, now);
}

/**
 * The items under the day each falls on, in the order the days first appear. A day is one group
 * wherever its items sit: the pages are read at different times and a row can move on a realtime
 * update, so the list is not always strictly newest first.
 */
export function groupByDay<T>(
  items: T[],
  at: (item: T) => string | Date,
  zone: string,
  now: number,
) {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).toPlainDate();
  const groups = new Map<string, { key: string; label: string | undefined; items: T[] }>();
  for (const item of items) {
    const date = Temporal.Instant.fromEpochMilliseconds(new Date(at(item)).getTime())
      .toZonedDateTimeISO(zone)
      .toPlainDate();
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
    // The year only where it is not this one.
    ...(date.year === today.year ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day)));
}
