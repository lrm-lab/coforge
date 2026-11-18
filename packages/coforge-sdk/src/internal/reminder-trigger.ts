import { hasControlCharacter } from "./control-characters";

export const REMINDER_TRIGGER_RESERVED_PREFIX = "coforge.";
export const REMINDER_TRIGGER_TITLE_MAX_CHARS = 200;
export const REMINDER_TRIGGER_DETAILS_MAX_BYTES = 4096;
export const REMINDER_TRIGGER_MERGE_WINDOW_MIN_SECONDS = 60;
export const REMINDER_TRIGGER_MERGE_WINDOW_MAX_SECONDS = 86_400;
export const REMINDER_TRIGGER_DEFAULT_MERGE_WINDOW_SECONDS = 600;
export const REMINDER_TRIGGER_WAKES_PER_HOUR = 6;
export const REMINDER_TRIGGER_CALLS_PER_MINUTE = 60;
export const REMINDER_TRIGGER_KEYS_PER_AGENT = 200;

const KEY = /^[A-Za-z0-9_.:-]{0,63}[A-Za-z0-9]$/;

export type ReminderTriggerLevel = "wake" | "log";
export type ReminderTriggerKeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: "invalid_key" | "reserved_prefix" };

export function parseReminderTriggerKey(
  raw: string,
  options: { allowReserved?: boolean } = {},
): ReminderTriggerKeyResult {
  if (!KEY.test(raw)) return { ok: false, reason: "invalid_key" };
  if (!options.allowReserved && raw.toLowerCase().startsWith(REMINDER_TRIGGER_RESERVED_PREFIX))
    return { ok: false, reason: "reserved_prefix" };
  return { ok: true, key: raw };
}

export function parseReminderTriggerLevel(
  raw: string | undefined,
): ReminderTriggerLevel | undefined {
  if (raw === undefined) return "wake";
  const level = raw.trim().toLowerCase();
  return level === "wake" || level === "log" ? level : undefined;
}

export function parseReminderTriggerMergeWindowSeconds(
  seconds: number | undefined,
): number | undefined {
  if (seconds === undefined) return REMINDER_TRIGGER_DEFAULT_MERGE_WINDOW_SECONDS;
  return Number.isInteger(seconds) &&
    seconds >= REMINDER_TRIGGER_MERGE_WINDOW_MIN_SECONDS &&
    seconds <= REMINDER_TRIGGER_MERGE_WINDOW_MAX_SECONDS
    ? seconds
    : undefined;
}

export function validateReminderTriggerTitle(title: string): boolean {
  return (
    title.trim().length > 0 &&
    [...title].length <= REMINDER_TRIGGER_TITLE_MAX_CHARS &&
    !/[\r\n]/.test(title) &&
    !hasControlCharacter(title)
  );
}

export function validateReminderTriggerDetails(details: string): boolean {
  return new TextEncoder().encode(details).length <= REMINDER_TRIGGER_DETAILS_MAX_BYTES;
}
