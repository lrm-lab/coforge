import { m } from "#src/paraglide/messages";

/** "Every hour", "Every 3 hours", "Daily at 09:00", "Weekly on Mon, Wed at 09:00" (task #126). */
export function formatRecurrence(value: string) {
  const every = /^every:([1-9]\d*)([mhd])$/.exec(value);
  if (every) {
    const count = every[1]!;
    const one = count === "1";
    if (every[2] === "m")
      return one ? m.agent_reminders_repeat_minute() : m.agent_reminders_repeat_minutes({ count });
    if (every[2] === "h")
      return one ? m.agent_reminders_repeat_hour() : m.agent_reminders_repeat_hours({ count });
    return one ? m.agent_reminders_repeat_day() : m.agent_reminders_repeat_days({ count });
  }
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
      .join(m.agent_reminders_weekday_separator());
    return m.agent_reminders_repeat_weekly({ days, time: weekly[2]! });
  }
  return m.agent_reminders_repeat_unknown({ value });
}
