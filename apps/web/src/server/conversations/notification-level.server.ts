import { AppError } from "#src/lib/app-error";

/** A person's channel notification level; Agents and DMs use only `all` and `muted`. */
export const NOTIFICATION_LEVELS = ["all", "relevant", "none", "muted"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export function isNotificationLevel(value: unknown): value is NotificationLevel {
  return NOTIFICATION_LEVELS.includes(value as NotificationLevel);
}

/** Agents and DMs have one switch: `muted` or `all`. */
export function onOffLevel(level: NotificationLevel): NotificationLevel {
  return level === "muted" ? "muted" : "all";
}

/** Whether a level suppresses unread/bold (and, for Agents, waking on ordinary messages). */
export function isMutedLevel(level: string | null | undefined): boolean {
  return level === "muted";
}

/** Whether a level pushes a message that is not an @mention, followed thread or task. */
export function pushesOrdinary(level: string | null | undefined): boolean {
  return level === "all";
}

export function validateNotificationLevel(level: unknown, onOff: boolean): NotificationLevel {
  if (!isNotificationLevel(level))
    throw new AppError("INVALID_INPUT", { errorId: "notification-level" });
  return onOff ? onOffLevel(level) : level;
}
