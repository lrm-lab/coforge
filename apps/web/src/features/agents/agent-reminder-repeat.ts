import { m } from "#src/paraglide/messages";

export function formatRecurrence(value: string) {
  const every = /^every:([1-9]\d*)([mhd])$/.exec(value);
  if (every)
    return m.agent_reminders_repeat_every({
      count: every[1]!,
      unit:
        every[2] === "m"
          ? m.agent_reminders_unit_minutes()
          : every[2] === "h"
            ? m.agent_reminders_unit_hours()
            : m.agent_reminders_unit_days(),
    });
  const daily = /^daily@(\d{2}:\d{2})$/.exec(value);
  if (daily) return m.agent_reminders_repeat_daily({ time: daily[1]! });
  const weekly = /^weekly:([a-z,]+)@(\d{2}:\d{2})$/.exec(value);
  if (weekly) {
    const weekdays: Record<string, string> = {
      mon: m.agent_reminders_weekday_mon(),
      tue: m.agent_reminders_weekday_tue(),
      wed: m.agent_reminders_weekday_wed(),
      thu: m.agent_reminders_weekday_thu(),
      fri: m.agent_reminders_weekday_fri(),
      sat: m.agent_reminders_weekday_sat(),
      sun: m.agent_reminders_weekday_sun(),
    };
    const days = weekly[1]!
      .split(",")
      .map((day) => weekdays[day] ?? day)
      .join(", ");
    return m.agent_reminders_repeat_weekly({ days, time: weekly[2]! });
  }
  return m.agent_reminders_repeat_unknown({ value });
}
