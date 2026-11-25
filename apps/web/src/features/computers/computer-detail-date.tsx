import { useHydrated } from "@tanstack/react-router";

import { formatCalendarDate } from "#src/lib/dates";
import { getLocale } from "#src/paraglide/runtime";

const MIN_VALID_TIMESTAMP_MS = 86_400_000;

export function isValidComputerDate(value: Date | string): boolean {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > MIN_VALID_TIMESTAMP_MS;
}

export function ComputerDate({
  value,
  timeZone,
}: {
  value: Date | string;
  timeZone: string | null;
}) {
  const hydrated = useHydrated();
  if (!isValidComputerDate(value)) return null;
  const instant = new Date(value).toISOString();
  return (
    <time dateTime={instant}>
      {hydrated ? formatCalendarDate(value, timeZone, getLocale()) : "\u00a0"}
    </time>
  );
}
