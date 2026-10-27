import { useHydrated } from "@tanstack/react-router";

import { formatCalendarDate } from "#src/lib/dates";
import { getLocale } from "#src/paraglide/runtime";

/** The day this Computer joined the Workspace, in the viewer's zone once the page is hydrated. */
export function ComputerDate({
  value,
  timeZone,
}: {
  value: Date | string;
  timeZone: string | null;
}) {
  const hydrated = useHydrated();
  const instant = new Date(value).toISOString();
  return (
    <time dateTime={instant}>
      {hydrated ? formatCalendarDate(value, timeZone, getLocale()) : " "}
    </time>
  );
}
