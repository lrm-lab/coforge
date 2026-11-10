import { createContext, useContext, useMemo, type ReactNode } from "react";

import { browserTimeZone, isValidTimeZone, resolveTimeZone } from "./dates";

const TimeZoneContext = createContext<string | undefined>(undefined);

/** What the server render knew of the clock: see `useRenderClock`. */
export type RenderClock = { zone: string | undefined; renderedAt: number };

const RenderClockContext = createContext<RenderClock>({ zone: undefined, renderedAt: 0 });

/**
 * Supplies the time zone that message times are formatted in: the zone the viewer saved in
 * Settings, else the browser's own. Only Chat's message rows read it, and they render in the
 * browser only.
 *
 * Also supplies the render's clock (`useRenderClock`): the zone the server could know (the saved
 * one, else the one the browser's cookie recorded) and when it rendered, both from the loader, so
 * the hydrating browser reads the same values.
 */
export function TimeZoneProvider({
  saved,
  cookie,
  renderedAt,
  children,
}: {
  /** The zone saved with the viewer's preferences; `null` follows the browser. */
  saved: string | null;
  /** The browser's zone as its cookie recorded it (`time-zone-cookie.ts`), if any. */
  cookie: string | null;
  /** When the loader ran, in epoch milliseconds. */
  renderedAt: number;
  children: ReactNode;
}) {
  const clock = useMemo(
    () => ({
      zone: saved && isValidTimeZone(saved) ? saved : (cookie ?? undefined),
      renderedAt,
    }),
    [saved, cookie, renderedAt],
  );
  return (
    <TimeZoneContext value={resolveTimeZone(saved, browserTimeZone())}>
      <RenderClockContext value={clock}>{children}</RenderClockContext>
    </TimeZoneContext>
  );
}

/** The zone message times show in: the viewer's saved zone, else the browser's. */
export function useTimeZone() {
  return useContext(TimeZoneContext) ?? resolveTimeZone(null, browserTimeZone());
}

/**
 * The zone and moment a render before hydration may use, the same on the server and in the
 * hydrating browser: `zone` is unknown (`undefined`) when the viewer saved none and the browser has
 * not yet recorded its own. After hydration, read `useTimeZone` and the browser's clock instead.
 */
export function useRenderClock() {
  return useContext(RenderClockContext);
}
