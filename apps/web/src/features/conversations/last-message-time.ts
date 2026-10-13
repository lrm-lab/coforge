import { clockLabel, formatMonthDay, startOfDay } from "#src/lib/dates";
import type { TimeFormat } from "#src/lib/time-format";

/**
 * The time a DM row shows for its last message: the clock time when the message was sent today in
 * `timeZone`, else its month and day. `now` is injected so the rule is testable.
 */
export function lastMessageTime(
  createdAt: string,
  {
    now,
    locale,
    timeZone,
    timeFormat,
  }: { now: Date; locale: string; timeZone: string; timeFormat: TimeFormat | null },
): string {
  const sentAt = new Date(createdAt);
  return sentAt.getTime() >= startOfDay(now, timeZone).getTime()
    ? clockLabel(sentAt, locale, timeFormat, timeZone)
    : formatMonthDay(sentAt, timeZone, locale);
}
