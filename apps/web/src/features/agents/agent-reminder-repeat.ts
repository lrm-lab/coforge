import { formatIsoWeekday } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

const CRON_WEEKDAY_TO_ISO = [7, 1, 2, 3, 4, 5, 6, 7] as const;
const CRON_WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function formatMinuteField(minute: number): string {
  return Temporal.PlainTime.from({ hour: 0, minute }).toString({ smallestUnit: "minute" }).slice(3);
}

function formatWallTime(hour: number, minute: number): string {
  return Temporal.PlainTime.from({ hour, minute }).toString({ smallestUnit: "minute" });
}

function parseIntBounded(field: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(field)) return undefined;
  const parsed = Number(field);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

function parseStep(field: string, max: number): number | undefined {
  const match = /^\*\/([1-9]\d*)$/.exec(field);
  if (!match) return undefined;
  const step = Number(match[1]);
  return step >= 1 && step <= max ? step : undefined;
}

function resolveWeekdayToken(token: string): number | undefined {
  if (token in CRON_WEEKDAY_NAMES) return CRON_WEEKDAY_NAMES[token];
  return parseIntBounded(token, 0, 7);
}

function parseCronWeekdays(field: string, locale: string): string[] | undefined {
  const seen = new Set<number>();
  const ordered: string[] = [];
  for (const token of field.toLowerCase().split(",")) {
    if (!token) return undefined;
    const parts = token.split("-");
    if (parts.length === 1) {
      const idx = resolveWeekdayToken(parts[0]!);
      if (idx === undefined) return undefined;
      const isoDay = CRON_WEEKDAY_TO_ISO[idx]!;
      if (!seen.has(isoDay)) {
        seen.add(isoDay);
        ordered.push(formatIsoWeekday(isoDay, locale, "short"));
      }
      continue;
    }
    if (parts.length === 2) {
      const start = resolveWeekdayToken(parts[0]!);
      const end = resolveWeekdayToken(parts[1]!);
      if (start === undefined || end === undefined) return undefined;
      const normalizedEnd = end === 0 && start > 0 ? 7 : end;
      if (start > normalizedEnd) return undefined;
      for (let d = start; d <= normalizedEnd; d += 1) {
        const isoDay = CRON_WEEKDAY_TO_ISO[d]!;
        if (!seen.has(isoDay)) {
          seen.add(isoDay);
          ordered.push(formatIsoWeekday(isoDay, locale, "short"));
        }
      }
      continue;
    }
    return undefined;
  }
  return ordered.length > 0 ? ordered : undefined;
}

function formatCron(value: string, locale: string): string | undefined {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (monthField !== "*" && monthField !== "*/1") return undefined;

  const isAnyDom = domField === "*" || domField === "*/1";
  const isAnyDow = dowField === "*" || dowField === "*/1";

  if (isAnyDom && isAnyDow && (hourField === "*" || hourField === "*/1")) {
    if (minField === "*") return m.agent_reminders_repeat_minutes({ count: 1 });
    const minStep = parseStep(minField, 59);
    if (minStep !== undefined) {
      return m.agent_reminders_repeat_minutes({ count: minStep });
    }
    const fixedMin = parseIntBounded(minField, 0, 59);
    if (fixedMin !== undefined) {
      return fixedMin === 0
        ? m.agent_reminders_repeat_hours({ count: 1 })
        : m.agent_reminders_repeat_hourly_at({ minute: formatMinuteField(fixedMin) });
    }
    return undefined;
  }

  const fixedMin = parseIntBounded(minField, 0, 59);
  if (fixedMin === undefined) return undefined;

  const hourStep = parseStep(hourField, 23);
  if (hourStep !== undefined && isAnyDom && isAnyDow) {
    return fixedMin === 0
      ? m.agent_reminders_repeat_hours({ count: hourStep })
      : m.agent_reminders_repeat_hours_at({
          count: hourStep,
          minute: formatMinuteField(fixedMin),
        });
  }

  const fixedHour = parseIntBounded(hourField, 0, 23);
  if (fixedHour === undefined) return undefined;
  const time = formatWallTime(fixedHour, fixedMin);

  if (isAnyDom && isAnyDow) return m.agent_reminders_repeat_daily({ time });

  if (isAnyDow) {
    const domStep = parseStep(domField, 31);
    if (domStep !== undefined) {
      return m.agent_reminders_repeat_days_at({ count: domStep, time });
    }
    const fixedDom = parseIntBounded(domField, 1, 31);
    if (fixedDom !== undefined) {
      return m.agent_reminders_repeat_monthly({ day: String(fixedDom), time });
    }
    return undefined;
  }

  if (isAnyDom) {
    const days = parseCronWeekdays(dowField, locale);
    if (!days) return undefined;
    return m.agent_reminders_repeat_weekly({
      days: days.join(m.agent_reminders_weekday_separator()),
      time,
    });
  }

  return undefined;
}

export function formatRecurrence(value: string) {
  const locale = getLocale();
  const every = /^every:([1-9]\d*)([mhd])$/.exec(value);
  if (every) {
    const count = Number(every[1]!);
    if (every[2] === "m") return m.agent_reminders_repeat_minutes({ count });
    if (every[2] === "h") return m.agent_reminders_repeat_hours({ count });
    return m.agent_reminders_repeat_days({ count });
  }
  const daily = /^daily@(\d{2}:\d{2})$/.exec(value);
  if (daily) return m.agent_reminders_repeat_daily({ time: daily[1]! });
  const weekly = /^weekly:([a-z,]+)@(\d{2}:\d{2})$/.exec(value);
  if (weekly) {
    const days = weekly[1]!
      .split(",")
      .map((token) => {
        const idx = CRON_WEEKDAY_NAMES[token];
        return idx === undefined
          ? token
          : formatIsoWeekday(CRON_WEEKDAY_TO_ISO[idx]!, locale, "short");
      })
      .join(m.agent_reminders_weekday_separator());
    return m.agent_reminders_repeat_weekly({ days, time: weekly[2]! });
  }
  const cron = formatCron(value, locale);
  if (cron) return cron;
  return m.agent_reminders_repeat_unknown({ value });
}
