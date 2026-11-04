import { MAX_PAUSE_MS } from "./notification-settings.schemas";

/** The pauses offered, as Raft's settings.notifications.pause: four spans and a time of one's own. */
export const PAUSES = ["30m", "1h", "2h", "tomorrow", "custom"] as const;
export type Pause = (typeof PAUSES)[number];

/** When a pause picked now ends: a span from now, or tomorrow at 9:00 on this computer's clock. */
export function pauseEnd(pause: Exclude<Pause, "custom">, now: Date): Date {
  if (pause === "tomorrow") {
    const end = new Date(now);
    end.setDate(end.getDate() + 1);
    end.setHours(9, 0, 0, 0);
    return end;
  }
  const minutes = { "30m": 30, "1h": 60, "2h": 120 }[pause];
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * The end a custom pause names, from a `datetime-local` value read on this computer's clock; null
 * when it names no time, one not after now, or one further ahead than a pause may run.
 */
export function customPauseEnd(value: string, now: Date): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const end = new Date(value);
  if (Number.isNaN(end.getTime())) return null;
  if (end <= now || end.getTime() - now.getTime() > MAX_PAUSE_MS) return null;
  return end;
}

/** A time as a `datetime-local` input holds it, on this computer's clock, to the minute. */
export function localInputValue(time: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}`;
}
