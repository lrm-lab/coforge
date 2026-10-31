import { useSyncExternalStore } from "react";

import { startOfDay } from "./dates";

const listeners = new Set<() => void>();
let ticking: ReturnType<typeof setInterval> | undefined;

/** Every minute, tells each reader to look at the day again: one timer for the page, running while
 * anyone reads. */
export function subscribeToMinutes(listener: () => void) {
  listeners.add(listener);
  ticking ??= setInterval(() => {
    for (const heard of listeners) heard();
  }, 60_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearInterval(ticking);
    ticking = undefined;
  };
}

/**
 * When today began in `timeZone` (epoch milliseconds). It moves at midnight, within a minute, and
 * renders its readers then and only then: a label that reads "today" differently (a clock time,
 * not a date) stays right without waiting for something else to render it.
 */
export function useStartOfToday(timeZone: string) {
  const read = () => startOfDay(new Date(), timeZone).getTime();
  return useSyncExternalStore(subscribeToMinutes, read, read);
}
