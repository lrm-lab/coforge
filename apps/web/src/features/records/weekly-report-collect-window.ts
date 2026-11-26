export type CollectWindowKind = "week" | "month" | "quarter" | "year" | "custom";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parsePlainDate(value: string): Temporal.PlainDate | null {
  const trimmed = value.trim();
  if (!YMD.test(trimmed)) return null;
  try {
    return Temporal.PlainDate.from(trimmed, { overflow: "reject" });
  } catch {
    return null;
  }
}

function plainDateToUtcDate(date: Temporal.PlainDate): Date {
  return new Date(date.toZonedDateTime("UTC").epochMilliseconds);
}

function utcDateToPlainDate(date: Date): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO("UTC")
    .toPlainDate();
}

function formatPlainDateLabel(date: Temporal.PlainDate): string {
  return date.toString().replaceAll("-", ".");
}

function buildCollectWindow(start: Temporal.PlainDate, endExclusive: Temporal.PlainDate) {
  return {
    windowStart: plainDateToUtcDate(start),
    windowEnd: plainDateToUtcDate(endExclusive),
    label: `${formatPlainDateLabel(start)} - ${formatPlainDateLabel(endExclusive.subtract({ days: 1 }))}`,
  };
}

export function isValidCollectCustomRange(startDate: string, endDate: string): boolean {
  const start = parsePlainDate(startDate);
  const end = parsePlainDate(endDate);
  if (!start || !end) return false;
  return Temporal.PlainDate.compare(start, end) <= 0;
}

export function formatCollectDayLabel(date: Date): string {
  return formatPlainDateLabel(utcDateToPlainDate(date));
}

export function formatCollectWindowLabel(windowStart: Date, windowEndExclusive: Date): string {
  const start = utcDateToPlainDate(windowStart);
  const endInclusive = utcDateToPlainDate(windowEndExclusive).subtract({ days: 1 });
  return `${formatPlainDateLabel(start)} - ${formatPlainDateLabel(endInclusive)}`;
}

export function isoWeekMondayPlainDate(year: number, week: number): Temporal.PlainDate {
  const jan4 = new Temporal.PlainDate(year, 1, 4);
  return jan4.subtract({ days: jan4.dayOfWeek - 1 }).add({ weeks: week - 1 });
}

export function isoWeekMonday(year: number, week: number): Date {
  return plainDateToUtcDate(isoWeekMondayPlainDate(year, week));
}

export function resolveCollectWindow(input: {
  kind: CollectWindowKind;
  year?: number;
  week?: number;
  month?: number;
  quarter?: number;
  customStart?: string;
  customEnd?: string;
  now?: Date;
}): { windowStart: Date; windowEnd: Date; label: string } {
  const nowDate = utcDateToPlainDate(input.now ?? new Date());
  if (input.kind === "custom") {
    const start = parsePlainDate(input.customStart ?? "");
    const end = parsePlainDate(input.customEnd ?? "");
    if (!start || !end || Temporal.PlainDate.compare(start, end) > 0) {
      throw new Error("invalid custom range");
    }
    return buildCollectWindow(start, end.add({ days: 1 }));
  }

  if (input.kind === "week") {
    const year = input.year ?? nowDate.year;
    const week = input.week ?? 1;
    const start = isoWeekMondayPlainDate(year, week);
    return buildCollectWindow(start, start.add({ weeks: 1 }));
  }

  if (input.kind === "month") {
    const year = input.year ?? nowDate.year;
    const month = input.month ?? nowDate.month;
    const start = new Temporal.PlainDate(year, month, 1);
    return buildCollectWindow(start, start.add({ months: 1 }));
  }

  if (input.kind === "quarter") {
    const year = input.year ?? nowDate.year;
    const quarter = input.quarter ?? Math.floor((nowDate.month - 1) / 3) + 1;
    const start = new Temporal.PlainDate(year, (quarter - 1) * 3 + 1, 1);
    return buildCollectWindow(start, start.add({ months: 3 }));
  }

  const year = input.year ?? nowDate.year;
  const start = new Temporal.PlainDate(year, 1, 1);
  return buildCollectWindow(start, start.add({ years: 1 }));
}

export function defaultCustomRangeEndingToday(now = new Date()): {
  startDate: string;
  endDate: string;
} {
  const end = utcDateToPlainDate(now);
  const start = end.subtract({ days: 6 });
  return {
    startDate: start.toString(),
    endDate: end.toString(),
  };
}

export function listCollectWindowOptions(
  kind: CollectWindowKind,
  now = new Date(),
): Array<{
  id: string;
  label: string;
  year?: number;
  week?: number;
  month?: number;
  quarter?: number;
}> {
  const today = utcDateToPlainDate(now);
  if (kind === "week") {
    const options: Array<{
      id: string;
      label: string;
      year: number;
      week: number;
    }> = [];
    for (let i = 0; i < 8; i += 1) {
      const day = today.subtract({ weeks: i });
      if (day.yearOfWeek === undefined || day.weekOfYear === undefined) {
        throw new Error(`missing ISO week for ${day.toString()}`);
      }
      const year = day.yearOfWeek;
      const week = day.weekOfYear;
      const range = resolveCollectWindow({ kind: "week", year, week });
      options.push({
        id: `${year}-W${week}`,
        label: range.label,
        year,
        week,
      });
    }
    return options;
  }
  if (kind === "month") {
    const currentMonth = new Temporal.PlainDate(today.year, today.month, 1);
    const options = [];
    for (let i = 0; i < 12; i += 1) {
      const date = currentMonth.subtract({ months: i });
      const range = resolveCollectWindow({ kind: "month", year: date.year, month: date.month });
      options.push({
        id: `${date.year}-${date.month}`,
        label: range.label,
        year: date.year,
        month: date.month,
      });
    }
    return options;
  }
  if (kind === "quarter") {
    const currentQuarterStart = new Temporal.PlainDate(
      today.year,
      Math.floor((today.month - 1) / 3) * 3 + 1,
      1,
    );
    const options = [];
    for (let i = 0; i < 8; i += 1) {
      const date = currentQuarterStart.subtract({ months: i * 3 });
      const quarter = Math.floor((date.month - 1) / 3) + 1;
      const range = resolveCollectWindow({ kind: "quarter", year: date.year, quarter });
      options.push({
        id: `${date.year}-Q${quarter}`,
        label: range.label,
        year: date.year,
        quarter,
      });
    }
    return options;
  }
  if (kind === "year") {
    const options = [];
    for (let i = 0; i < 5; i += 1) {
      const year = today.year - i;
      const range = resolveCollectWindow({ kind: "year", year });
      options.push({ id: String(year), label: range.label, year });
    }
    return options;
  }
  return [];
}
