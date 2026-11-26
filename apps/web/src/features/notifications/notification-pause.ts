import { localDateTimeInput } from "#src/lib/dates";
import { MAX_PAUSE_MS } from "./notification-settings.schemas";

export const PAUSES = ["30m", "1h", "2h", "tomorrow", "custom"] as const;
export type Pause = (typeof PAUSES)[number];

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const PAUSE_MINUTES: Record<Exclude<Pause, "tomorrow" | "custom">, number> = {
  "30m": 30,
  "1h": 60,
  "2h": 120,
};

export function pauseEnd(
  pause: Exclude<Pause, "custom">,
  now: Date,
  timeZone: string = Temporal.Now.timeZoneId(),
): Date {
  const nowInstant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
  if (pause === "tomorrow") {
    const end = nowInstant.toZonedDateTimeISO(timeZone).add({ days: 1 }).withPlainTime("09:00");
    return new Date(end.epochMilliseconds);
  }
  return new Date(nowInstant.add({ minutes: PAUSE_MINUTES[pause] }).epochMilliseconds);
}

export function customPauseEnd(
  value: string,
  now: Date,
  timeZone: string = Temporal.Now.timeZoneId(),
): Date | null {
  if (!LOCAL_DATE_TIME.test(value)) return null;
  let endInstant: Temporal.Instant;
  try {
    endInstant = Temporal.PlainDateTime.from(value, { overflow: "reject" })
      .toZonedDateTime(timeZone)
      .toInstant();
  } catch {
    return null;
  }
  const nowInstant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
  const deltaMs = endInstant.epochMilliseconds - nowInstant.epochMilliseconds;
  if (deltaMs <= 0 || deltaMs > MAX_PAUSE_MS) return null;
  return new Date(endInstant.epochMilliseconds);
}

export function localInputValue(time: Date, timeZone: string = Temporal.Now.timeZoneId()): string {
  return localDateTimeInput(time, timeZone);
}
