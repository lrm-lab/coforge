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

/** Month, day and time of day, as Raft writes a forwarded original's moment: "Oct 29, 6:06 PM" in
 * English, "10月29日 18:06" in Chinese, in the viewer's hour cycle. A moment from another year
 * than `now`'s writes its year too ("Oct 29, 2025, 6:06 PM", "2025.10.29 18:06"). */
export function formatMonthDayTime(
  value: Date | string,
  timeZone: string | null | undefined,
  locale: string,
  timeFormat: TimeFormat | null = null,
  now: Date = new Date(),
) {
  const zone = resolveTimeZone(timeZone, browserTimeZone());
  const yearOf = (date: Date) =>
    dateTimeFormat(locale, { year: "numeric", timeZone: zone }).format(date);
  const date = new Date(value);
  const time = dateTimeFormat(locale, {
    hour: "numeric",
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
) {
  return dateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: hour12For(timeFormat),
    timeZone: resolveTimeZone(timeZone, browserTimeZone()),
  }).format(new Date(value));
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

function isValidTimeZone(value: string) {
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
