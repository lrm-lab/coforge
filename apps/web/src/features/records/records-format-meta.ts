import { z } from "zod";
import { dateTimeFormat } from "#src/lib/dates";
import { WEEKLY_REPORT_SCHEDULE_TIME_ZONE } from "./weekly-report-schedule-due";

export type ReportAssignmentMeta = {
  unread: boolean;
};

export type ReportScheduleMeta = {
  cancelledYear: number;
  cancelledWeek: number;
  dismissSend?: boolean;
};

const assignmentMetaSchema = z.object({
  unread: z.boolean(),
});

const scheduleMetaSchema = z
  .object({
    cancelledYear: z.int(),
    cancelledWeek: z.int(),
    dismissSend: z.unknown().optional(),
  })
  .transform(({ cancelledYear, cancelledWeek, dismissSend }): ReportScheduleMeta => ({
    cancelledYear,
    cancelledWeek,
    ...(dismissSend === true ? { dismissSend: true } : {}),
  }));

export function parseAssignmentMeta(value: unknown): ReportAssignmentMeta | undefined {
  const parsed = assignmentMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseScheduleMeta(value: unknown): ReportScheduleMeta | undefined {
  const parsed = scheduleMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const RTL_SCRIPT_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

export function bidiIsolateName(value: string): string {
  return RTL_SCRIPT_RE.test(value) ? `\u2068${value}\u2069` : value;
}

export function memberWeekTitle(year: number, week: number): string {
  return `${year} W${week} 工作周报`;
}

export function memberReportTitle(displayName: string, year: number, week: number): string {
  return `${bidiIsolateName(displayName)} ${year} W${week} 工作周报`;
}

export function formatWeeklyReportCompletedAt(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = dateTimeFormat("en-US", {
    timeZone: WEEKLY_REPORT_SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}.${get("month")}.${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function isValidIsoWeekNumber(week: number): boolean {
  return Number.isInteger(week) && week >= 1 && week <= 53;
}

export function isValidTemplateName(name: string): boolean {
  const length = name.trim().length;
  return length > 0 && length <= 100;
}

export function hourlySendTimes(): string[] {
  return Array.from({ length: 24 }, (_, hour) =>
    Temporal.PlainTime.from({ hour }).toString({ smallestUnit: "minute" }),
  );
}

export function isHourlySendTime(value: string): boolean {
  return /^([01]\d|2[0-3]):00$/.test(value);
}

export function formatRecipientSummary(names: readonly string[]): string {
  if (names.length === 0) return "";
  const visible = names.slice(0, 3);
  const more = names.length - visible.length;
  const label = visible.join("，");
  return more > 0 ? `${label}...+${more}` : label;
}
