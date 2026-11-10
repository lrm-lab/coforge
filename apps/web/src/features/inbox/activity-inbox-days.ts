import { useEffect, useState } from "react";
import { useHydrated } from "@tanstack/react-router";

import { dateTimeFormat } from "#src/lib/dates";
import { useRenderClock, useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

/**
 * The days an Activity list falls on, newest first: each item goes under the day of its latest
 * message, in the viewer's time zone.
 *
 * Before hydration the days come from the render's clock (`useRenderClock`): the zone the server
 * knew and the moment it rendered, which the hydrating browser reads the same, so the list is
 * grouped from its first frame and nothing moves when it hydrates (task #68). With no zone known
 * yet (no saved zone, no cookie: a first visit) the whole list is one group with no heading until
 * hydration. After it, the viewer's zone and the browser's clock, read at once on mount (loader
 * data can be minutes old) and every minute after.
 */
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
  if (!hydrated) {
    return render.zone
      ? groupByDay(items, at, render.zone, render.renderedAt)
      : [{ key: "all", label: undefined, items }];
  }
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
    // The weekday within this year, as Slack heads its days; the year only where it is not this one.
    ...(date.year === today.year ? { weekday: "long" } : { year: "numeric" }),
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day)));
}
