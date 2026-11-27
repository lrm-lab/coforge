export interface TimeZoneOption {
  id: string;
  label: string;
  offsetMinutes: number;
  keywords: string;
}

const DEFAULT_TIME_ZONES = Array.from(
  new Set([
    "UTC",
    ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []),
  ]),
);

const cachedOptionsByLocale = new Map<string, readonly TimeZoneOption[]>();

export function formatOffsetSearchAliases(offsetMinutes: number): string {
  if (offsetMinutes === 0) {
    return "UTC+0 GMT+0 GMT+00:00 GMT";
  }

  const sign = offsetMinutes > 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  const paddedHours = String(hours).padStart(2, "0");
  const paddedMinutes = String(minutes).padStart(2, "0");
  const shortOffset = minutes === 0 ? String(hours) : `${hours}:${paddedMinutes}`;

  return `${sign}${shortOffset} UTC${sign}${shortOffset} GMT${sign}${shortOffset} GMT${sign}${paddedHours}:${paddedMinutes}`;
}

export function getLocalizedTimeZoneName(
  timeZone: string,
  locale: string,
  now = new Date(),
): string {
  try {
    return (
      new Intl.DateTimeFormat(locale, {
        timeZone,
        timeZoneName: "longGeneric",
      })
        .formatToParts(now)
        .find((part) => part.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

function buildBaseTimeZoneOptions(
  locale: string,
  zones: readonly string[],
  now: Date,
): TimeZoneOption[] {
  return zones
    .map((timeZone) => {
      const offset = getUtcOffset(timeZone, now);
      const city = (timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ");
      const label = `(${offset.label}) ${city} - ${timeZone}`;
      const localized = getLocalizedTimeZoneName(timeZone, locale, now);
      const aliases = formatOffsetSearchAliases(offset.minutes);

      return {
        id: timeZone,
        label,
        offsetMinutes: offset.minutes,
        keywords: localized ? `${aliases} ${localized}` : aliases,
      };
    })
    .sort(
      (left, right) =>
        left.offsetMinutes - right.offsetMinutes || left.label.localeCompare(right.label),
    );
}

function getCachedBaseTimeZoneOptions(locale: string): readonly TimeZoneOption[] {
  const existing = cachedOptionsByLocale.get(locale);
  if (existing) return existing;

  const built = buildBaseTimeZoneOptions(locale, DEFAULT_TIME_ZONES, new Date());
  cachedOptionsByLocale.set(locale, built);
  return built;
}

export function buildTimeZonePickerOptions({
  locale,
  systemLabel,
  selectedZone,
  zones,
  now,
}: {
  locale: string;
  systemLabel: string;
  selectedZone?: string | null;
  zones?: readonly string[];
  now?: Date;
}): TimeZoneOption[] {
  const baseOptions =
    zones === undefined && now === undefined
      ? getCachedBaseTimeZoneOptions(locale)
      : buildBaseTimeZoneOptions(locale, zones ?? DEFAULT_TIME_ZONES, now ?? new Date());

  const systemOption: TimeZoneOption = {
    id: "system",
    label: systemLabel,
    offsetMinutes: 0,
    keywords: "system",
  };

  if (selectedZone && !baseOptions.some((option) => option.id === selectedZone)) {
    return [
      systemOption,
      {
        id: selectedZone,
        label: selectedZone,
        offsetMinutes: 0,
        keywords: selectedZone,
      },
      ...baseOptions,
    ];
  }

  return [systemOption, ...baseOptions];
}

function getUtcOffset(timeZone: string, now: Date) {
  const timeZoneName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = timeZoneName?.match(/^GMT(?:([+-])(\d{2}):(\d{2}))?$/);

  if (!match?.[1] || !match?.[2] || !match?.[3]) {
    return { label: "UTC+00:00", minutes: 0 };
  }

  const sign = match[1] === "+" ? 1 : -1;
  return {
    label: `UTC${match[1]}${match[2]}:${match[3]}`,
    minutes: sign * (Number(match[2]) * 60 + Number(match[3])),
  };
}
