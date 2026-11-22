import { formatMonthDayOrYear } from "#src/lib/dates";

export function formatTaskCardDate(
  value: Date | string,
  timeZone: string | null | undefined,
  locale: string,
  now?: Date,
  dueHasTime?: boolean,
): string {
  return formatMonthDayOrYear(value, timeZone, locale, { now, dueHasTime });
}
