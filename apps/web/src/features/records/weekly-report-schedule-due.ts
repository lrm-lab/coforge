export const WEEKLY_REPORT_SCHEDULE_TIME_ZONE = "Asia/Shanghai";

const HH_MM = /^\d{2}:\d{2}$/;

export function parseScheduleTime(sendTime: string): Temporal.PlainTime | null {
  if (!HH_MM.test(sendTime)) return null;
  try {
    return Temporal.PlainTime.from(sendTime, { overflow: "reject" });
  } catch {
    return null;
  }
}

export function zonedWeekdayAndTime(
  now: Date,
  timeZone: string = WEEKLY_REPORT_SCHEDULE_TIME_ZONE,
): { weekday: number; time: string } {
  const zoned = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone);
  return {
    weekday: zoned.dayOfWeek,
    time: `${String(zoned.hour).padStart(2, "0")}:${String(zoned.minute).padStart(2, "0")}`,
  };
}

export function isoWeekOfDate(date: Date): { year: number; week: number } {
  const zoned = Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(
    Temporal.Now.timeZoneId(),
  );
  if (zoned.yearOfWeek === undefined || zoned.weekOfYear === undefined) {
    throw new Error(`missing ISO week for ${zoned.toString()}`);
  }
  return { year: zoned.yearOfWeek, week: zoned.weekOfYear };
}

export function currentScheduledIsoWeek(now: Date = new Date()): { year: number; week: number } {
  const zoned = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(
    WEEKLY_REPORT_SCHEDULE_TIME_ZONE,
  );
  if (zoned.yearOfWeek === undefined || zoned.weekOfYear === undefined) {
    throw new Error(`missing ISO week for ${zoned.toString()}`);
  }
  return { year: zoned.yearOfWeek, week: zoned.weekOfYear };
}

export function isWeeklyScheduleDue(input: {
  now: Date;
  sendWeekday: number;
  sendTime: string;
  timeZone?: string;
}): boolean {
  if (input.sendWeekday < 1 || input.sendWeekday > 7) return false;
  const targetTime = parseScheduleTime(input.sendTime);
  if (!targetTime) return false;
  const zoned = Temporal.Instant.fromEpochMilliseconds(input.now.getTime()).toZonedDateTimeISO(
    input.timeZone ?? WEEKLY_REPORT_SCHEDULE_TIME_ZONE,
  );
  if (zoned.dayOfWeek !== input.sendWeekday) return false;
  return Temporal.PlainTime.compare(zoned.toPlainTime(), targetTime) >= 0;
}
