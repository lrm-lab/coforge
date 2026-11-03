/** The canonical recurrence grammar: a nonzero interval, a daily clock, or a weekly clock. */
export const RECURRENCE =
  /^(?:every:[1-9]\d*[mhd]|daily@(?:[01]\d|2[0-3]):[0-5]\d|weekly:(?:mon|tue|wed|thu|fri|sat|sun)(?:,(?:mon|tue|wed|thu|fri|sat|sun))*@(?:[01]\d|2[0-3]):[0-5]\d)$/;
/** One parsed recurrence spelling of the canonical `RECURRENCE` grammar. */
export type ReminderRecurrence =
  | { kind: "every"; count: number; unit: "m" | "h" | "d" }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekdays: string[]; hour: number; minute: number };

/** Parse a recurrence string against the canonical grammar, or `undefined` when it does not
 * match. The three patterns are the same alternatives `RECURRENCE` validates — nonzero interval
 * counts, real clock hours, known weekday tokens — so a parse failure and a validation failure
 * agree on exactly the same strings. Consumers of a validated reminder repeat — the cloud's
 * `nextOccurrence` — parse through here so the grammar lives in one file next to the `RECURRENCE`
 * regex that validates it, and a grammar change cannot leave a downstream parser behind. */
export function parseReminderRecurrence(value: string): ReminderRecurrence | undefined {
  const interval = /^every:([1-9]\d*)([mhd])$/.exec(value);
  if (interval)
    return {
      kind: "every",
      count: Number(interval[1]),
      unit: interval[2] as "m" | "h" | "d",
    };
  const daily = /^daily@([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (daily) return { kind: "daily", hour: Number(daily[1]), minute: Number(daily[2]) };
  const weekly =
    /^weekly:((?:mon|tue|wed|thu|fri|sat|sun)(?:,(?:mon|tue|wed|thu|fri|sat|sun))*)@([01]\d|2[0-3]):([0-5]\d)$/.exec(
      value,
    );
  if (weekly)
    return {
      kind: "weekly",
      weekdays: weekly[1]!.split(","),
      hour: Number(weekly[2]),
      minute: Number(weekly[3]),
    };
  return undefined;
}

/**
 * The timezone a repeating reminder takes when the caller names none. A product default rather than
 * an implementation detail: the CLI applies it locally while validating a request, and the server
 * applies it when the reminder is written, so both edges have to agree — otherwise the same command
 * would be accepted as one clock and stored as another.
 */
export const DEFAULT_REMINDER_TIMEZONE = "Asia/Shanghai";
