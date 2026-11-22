import { hour12For, type TimeFormat } from "./time-format";

export const DEFAULT_TIME_ZONE = "UTC";

export function validateTimeZone(value: string): string {
  if (!value || !isValidTimeZone(value)) throw new Error("Invalid IANA time zone");
  return value;
}

export function resolveTimeZone(preference: string | null | undefined, browserTimeZone?: string) {
  if (preference && isValidTimeZone(preference)) return preference;
  if (browserTimeZone && isValidTimeZone(browserTimeZone)) return browserTimeZone;
  return DEFAULT_TIME_ZONE;
}

let cachedBrowserTimeZone: string | undefined;

/** The browser's own zone, read once per page load like the formatters below that bake it in. */
export function browserTimeZone() {
  cachedBrowserTimeZone ??=
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  return cachedBrowserTimeZone;
}

// Building an `Intl` formatter costs far more than formatting with one, and a long list formats
// the same few shapes hundreds of times per render, so each shape is built once.
function cached<T>(cache: Map<string, T>, key: string, create: () => T) {
  let value = cache.get(key);
  if (value === undefined) {
    value = create();
    cache.set(key, value);
  }
  return value;
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  return cached(
    dateTimeFormats,
    `${locale}\u0000${JSON.stringify(options)}`,
    () => new Intl.DateTimeFormat(locale, options),
  );
}

const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

export function formatDateForDisplay(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
  timeFormat: TimeFormat | null = null,
) {
  return dateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: hour12For(timeFormat),
    timeZone: resolveTimeZone(timeZone, browserTimeZone()),
  }).format(new Date(value));
}

/** A moment to the second, with its full date: "2026年10月27日 16:19:30" in Chinese, the language's
 * own long date and time elsewhere (for example "October 27, 2026 at 4:19:30 PM"). */
export function formatMomentForDisplay(
  value: Date | string,
  timeZone: string | null | undefined,
  locale: string,
  timeFormat: TimeFormat | null = null,
) {
  return dateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "medium",
    hour12: hour12For(timeFormat),
    timeZone: resolveTimeZone(timeZone, browserTimeZone()),
  }).format(new Date(value));
}

/** The calendar day only, no time of day: "2026.07.23" in Chinese, the language's own medium
 * date elsewhere (for example "Jul 23, 2026"). */
export function formatCalendarDate(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  const zone = resolveTimeZone(timeZone, browserTimeZone());
  if (!locale.toLowerCase().startsWith("zh")) {
    return dateTimeFormat(locale, { dateStyle: "medium", timeZone: zone }).format(new Date(value));
  }
  const parts = dateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: zone,
  }).formatToParts(new Date(value));
  const part = (type: "year" | "month" | "day") =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}.${part("month")}.${part("day")}`;
}

/** Month and day only, in the language's own short form: "10月6日" in Chinese, "Oct 6" in English. */
export function formatMonthDay(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  return dateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: resolveTimeZone(timeZone, browserTimeZone()),
  }).format(new Date(value));
}

export function formatMonthDayOrYear(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
  options?: { now?: Date; dueHasTime?: boolean },
) {
  const zone = resolveTimeZone(timeZone, browserTimeZone());
  const rawInstant = Temporal.Instant.fromEpochMilliseconds(new Date(value).getTime());
  const targetInstant =
    options?.dueHasTime === false ? rawInstant.subtract({ milliseconds: 1 }) : rawInstant;
  const targetZoned = targetInstant.toZonedDateTimeISO(zone);
  const nowZoned = (
    options?.now
      ? Temporal.Instant.fromEpochMilliseconds(options.now.getTime())
      : Temporal.Now.instant()
  ).toZonedDateTimeISO(zone);
  const targetDate = new Date(targetInstant.epochMilliseconds);
  return targetZoned.year === nowZoned.year
    ? formatMonthDay(targetDate, zone, locale)
    : formatCalendarDate(targetDate, zone, locale);
}

export function formatIsoWeekday(
  isoDay: number,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
  style: "short" | "long" = "short",
) {
  const normalized = ((((isoDay - 1) % 7) + 7) % 7) + 1;
  return dateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, normalized, 12)),
  );
}

/** Month, day and time of day, as Raft writes a forwarded original's moment: "Oct 29, 6:06 PM" in
 * English, "10月29日 18:06" in Chinese, in the viewer's hour cycle. A moment from another year
 * than `now`'s writes its year too ("Oct 29, 2025, 6:06 PM", "2025.10.29 18:06"). `hour:
 * "2-digit"` writes the clock as `clockLabel` does ("Oct 29, 06:06 PM"), for a line among others
 * that show the time alone. */
export function formatMonthDayTime(
  value: Date | string,
  timeZone: string | null | undefined,
  locale: string,
  timeFormat: TimeFormat | null = null,
  { now = new Date(), hour = "numeric" }: { now?: Date; hour?: "numeric" | "2-digit" } = {},
) {
  const zone = resolveTimeZone(timeZone, browserTimeZone());
  const yearOf = (date: Date) =>
    dateTimeFormat(locale, { year: "numeric", timeZone: zone }).format(date);
  const date = new Date(value);
  const time = dateTimeFormat(locale, {
    hour,
    minute: "2-digit",
    hour12: hour12For(timeFormat),
    timeZone: zone,
  }).format(date);
  // Chinese runs the time on after the day; elsewhere a comma sets it off.
  const separator = locale.toLowerCase().startsWith("zh") ? " " : ", ";
  const day =
    yearOf(date) === yearOf(now)
      ? formatMonthDay(date, zone, locale)
      : formatCalendarDate(date, zone, locale);
  return `${day}${separator}${time}`;
}

/** The time of day a message was sent at, in `timeZone`; empty without a `locale`. */
export function clockLabel(
  value: Date | string,
  locale?: string,
  timeFormat: TimeFormat | null = null,
  timeZone?: string,
): string {
  if (!locale) return "";
  return dateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12For(timeFormat),
    timeZone,
  }).format(new Date(value));
}

/** Absolute wall-clock time with seconds, for contexts that need a fixed timestamp instead of
 * relative text (the Activity timeline's clock column), in the viewer's hour cycle. */
export function formatClockTime(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
  timeFormat: TimeFormat | null = null,
  seconds = true,
) {
  const format = dateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hour12: hour12For(timeFormat),
    timeZone: resolveTimeZone(timeZone, browserTimeZone()),
  });
  const instant = new Date(value);
  if (seconds) return format.format(instant);
  // A 12-hour clock writes "9:49 AM", not "09:49 AM"; a 24-hour one keeps "09:49".
  const parts = format.formatToParts(instant);
  const twelve = parts.some((part) => part.type === "dayPeriod");
  return parts
    .map((part) => (twelve && part.type === "hour" ? part.value.replace(/^0/, "") : part.value))
    .join("");
}

/** The instant the calendar day containing `now` began in `timeZone` (viewer preference, then
 * the browser's zone). Correct across a daylight-saving change earlier that day. */
export function startOfDay(now: Date, timeZone: string | null | undefined): Date {
  return new Date(zonedDateTime(now, timeZone).startOfDay().epochMilliseconds);
}

/** The same wall-clock time `days` calendar days after `now` in `timeZone` (viewer preference,
 * then the browser's zone): a day across a daylight-saving change is 23 or 25 hours. */
export function addCalendarDays(
  now: Date,
  days: number,
  timeZone: string | null | undefined,
): Date {
  return new Date(zonedDateTime(now, timeZone).add({ days }).epochMilliseconds);
}

/** `value` as a moment on the wall clock of `timeZone` (viewer preference, then the browser's). */
function zonedDateTime(value: Date | string, timeZone: string | null | undefined) {
  return Temporal.Instant.fromEpochMilliseconds(new Date(value).getTime()).toZonedDateTimeISO(
    resolveTimeZone(timeZone, browserTimeZone()),
  );
}

/** `value` as the wall time a `datetime-local` field edits in `timeZone` (viewer preference,
 * then the browser's): `YYYY-MM-DDTHH:mm`. */
export function localDateTimeInput(value: Date | string, timeZone: string | null | undefined) {
  const zoned = zonedDateTime(value, timeZone);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}T${pad(zoned.hour)}:${pad(zoned.minute)}`;
}

/** `value` as a `date` field (`YYYY-MM-DD`) in `timeZone`. Date-only deadlines (`dueHasTime ===
 * false`) store the end of that day (next day 00:00), so we step back 1 ms to recover the day. */
export function localDateInput(
  value: Date | string,
  timeZone: string | null | undefined,
  dueHasTime = true,
): string {
  const adjusted = dueHasTime ? value : new Date(new Date(value).getTime() - 1);
  const zoned = zonedDateTime(adjusted, timeZone);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`;
}

/** The instant a date-only field (`YYYY-MM-DD`) names as the end of that day (next day 00:00)
 * in `timeZone`. */
export function instantFromLocalDate(value: string, timeZone: string | null | undefined): string {
  return Temporal.PlainDate.from(value)
    .add({ days: 1 })
    .toZonedDateTime(resolveTimeZone(timeZone, browserTimeZone()))
    .toInstant()
    .toString();
}

/** Formats a Task's due date: calendar day only when `dueHasTime === false`, date + time otherwise. */
export function formatTaskDueForDisplay(
  value: Date | string,
  dueHasTime: boolean | undefined,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
  timeFormat: TimeFormat | null = null,
): string {
  if (dueHasTime === false) {
    return formatCalendarDate(new Date(new Date(value).getTime() - 1), timeZone, locale);
  }
  return formatDateForDisplay(value, timeZone, locale, timeFormat);
}

/** The instant a `datetime-local` field's wall time names in `timeZone` (viewer preference,
 * then the browser's); a wall time a daylight-saving change skips or repeats resolves as
 * `toZonedDateTime` resolves it. Throws on text that is not a date-time. */
export function instantFromLocalDateTime(
  value: string,
  timeZone: string | null | undefined,
): string {
  return Temporal.PlainDateTime.from(value)
    .toZonedDateTime(resolveTimeZone(timeZone, browserTimeZone()))
    .toInstant()
    .toString();
}

export function formatRelativeTime(
  value: Date | string,
  now = new Date(),
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  const seconds = (new Date(value).getTime() - now.getTime()) / 1_000;
  const absoluteSeconds = Math.abs(seconds);
  const formatter = cached(
    relativeTimeFormats,
    locale,
    () => new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }),
  );
  if (absoluteSeconds < 60) return formatter.format(0, "second");

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const [unit, unitSeconds] =
    units.find(([, threshold]) => absoluteSeconds >= threshold) ?? (["minute", 60] as const);
  const amount = Math.sign(seconds) * Math.floor(absoluteSeconds / unitSeconds);
  return formatter.format(amount, unit);
}

// Only canonical zone names are remembered: that set is small and fixed, while other accepted
// spellings (any casing, raw offsets) and rejected values can be arbitrary user input
// (`validateTimeZone` runs on the server).
const canonicalTimeZones = new Set<string>();

export function isValidTimeZone(value: string) {
  if (canonicalTimeZones.has(value)) return true;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  if (resolved === value) canonicalTimeZones.add(value);
  return true;
}
