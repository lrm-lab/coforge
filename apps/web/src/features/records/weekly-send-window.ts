import { WEEKLY_REPORT_SCHEDULE_TIME_ZONE, parseScheduleTime } from "./weekly-report-schedule-due";
import { isoWeekMondayPlainDate } from "./weekly-report-collect-window";

export function currentWeekTemplateTitle(year: number, week: number): string {
  return `${year} W${week} 模板`;
}

export function formatChipLabel(input: {
  year: number;
  week: number;
  settingsName?: string | null;
  distinguishSettingsName?: boolean;
}): string {
  const weekTitle = currentWeekTemplateTitle(input.year, input.week);
  const settingsName = input.settingsName?.trim() ?? "";
  if (input.distinguishSettingsName && settingsName.length > 0 && settingsName !== weekTitle) {
    return `${weekTitle} · ${settingsName}`;
  }
  return weekTitle;
}

export function splitWeeklyTemplateRoles<T extends { hasAssignments: boolean }>(
  templates: T[],
): {
  formats: T[];
  overviews: T[];
} {
  return {
    formats: templates.filter((template) => !template.hasAssignments),
    overviews: templates.filter((template) => template.hasAssignments),
  };
}

export function pickPinnedWeekTemplate<
  T extends { year: number; week: number; createdAtMs: number },
>(templates: T[], current: { year: number; week: number }): T | undefined {
  const currentWeek = templates.filter(
    (template) => template.year === current.year && template.week === current.week,
  );
  if (currentWeek.length > 0) {
    return [...currentWeek].sort((left, right) => right.createdAtMs - left.createdAtMs)[0];
  }
  return templates[0];
}

export function formatSendWindowCountdown(remainingMs: number): string {
  const clamped = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatOfferSendWeekTitle(year: number, week: number): string {
  const monday = isoWeekMondayPlainDate(year, week);
  const friday = monday.add({ days: 4 });
  const md = (date: Temporal.PlainDate) =>
    `${String(date.month).padStart(2, "0")}.${String(date.day).padStart(2, "0")}`;
  return `${year} W${week} (${md(monday)}-${md(friday)})`;
}

function resolveSendSchedule(input: {
  now: Date;
  sendWeekday: number;
  sendTime: string;
  timeZone?: string;
}): { previewStart: Date; sendInstant: Date; dayEnd: Date } | null {
  if (input.sendWeekday < 1 || input.sendWeekday > 7) return null;
  const plainTime = parseScheduleTime(input.sendTime);
  if (!plainTime) return null;
  const timeZone = input.timeZone ?? WEEKLY_REPORT_SCHEDULE_TIME_ZONE;
  const zonedNow = Temporal.Instant.fromEpochMilliseconds(input.now.getTime()).toZonedDateTimeISO(
    timeZone,
  );
  const sendDate = zonedNow.toPlainDate().add({ days: input.sendWeekday - zonedNow.dayOfWeek });
  const sendInstant = sendDate.toZonedDateTime({ timeZone, plainTime }).toInstant();
  const previewStart = sendInstant.subtract({ hours: 1 });
  const dayEnd = sendDate.add({ days: 1 }).toZonedDateTime(timeZone).toInstant();
  return {
    previewStart: new Date(previewStart.epochMilliseconds),
    sendInstant: new Date(sendInstant.epochMilliseconds),
    dayEnd: new Date(dayEnd.epochMilliseconds),
  };
}

export function weeklySendWindow(input: {
  now: Date;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  timeZone?: string;
}): { start: Date; end: Date } | null {
  const schedule = resolveSendSchedule(input);
  if (!schedule) return null;
  return input.scheduleEnabled
    ? { start: schedule.previewStart, end: schedule.sendInstant }
    : { start: schedule.sendInstant, end: schedule.dayEnd };
}

export function isInWeeklySendWindow(input: {
  now: Date;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  timeZone?: string;
}): boolean {
  const window = weeklySendWindow(input);
  if (!window) return false;
  return (
    input.now.getTime() >= window.start.getTime() && input.now.getTime() < window.end.getTime()
  );
}

export function isWeeklySendArmed(input: {
  applied: boolean;
  alreadySent: boolean;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  autoSendCancelled?: boolean;
  now: Date;
}): boolean {
  if (!input.applied || input.alreadySent || input.autoSendCancelled) return false;
  return isInWeeklySendWindow({
    now: input.now,
    sendWeekday: input.sendWeekday,
    sendTime: input.sendTime,
    scheduleEnabled: input.scheduleEnabled,
  });
}

export function isWeeklyTemplateChipHighlighted(input: {
  applied: boolean;
  alreadySent: boolean;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  autoSendCancelled?: boolean;
  now: Date;
}): boolean {
  if (!input.applied) return false;
  if (isWeeklySendArmed(input)) return true;
  const window = weeklySendWindow({
    now: input.now,
    sendWeekday: input.sendWeekday,
    sendTime: input.sendTime,
    scheduleEnabled: input.scheduleEnabled,
  });
  if (!window) return false;
  return input.now.getTime() >= window.end.getTime();
}

export function canSendWeeklyAssignmentsNow(input: {
  applied: boolean;
  alreadySent: boolean;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  autoSendCancelled?: boolean;
  now: Date;
}): boolean {
  if (!input.applied || input.alreadySent) return false;
  const schedule = resolveSendSchedule(input);
  if (!schedule) return false;
  const start = input.scheduleEnabled ? schedule.previewStart : schedule.sendInstant;
  return input.now.getTime() >= start.getTime() && input.now.getTime() < schedule.dayEnd.getTime();
}
