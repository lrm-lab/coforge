import { AppError } from "#src/lib/app-error";

/** A person's channel notification level; Agents and DMs use only `all` and `muted`. */
export const NOTIFICATION_LEVELS = ["all", "relevant", "none", "muted"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export function isNotificationLevel(value: unknown): value is NotificationLevel {
  return NOTIFICATION_LEVELS.includes(value as NotificationLevel);
}

/** A stored level as a read returns it; anything else (no membership) reads as `all`. */
export function readNotificationLevel(value: string | null | undefined): NotificationLevel {
  return isNotificationLevel(value) ? value : "all";
}

/** Agents and DMs have one switch: `muted` or `all`. */
export function onOffLevel(level: NotificationLevel): NotificationLevel {
  return level === "muted" ? "muted" : "all";
}

/** Whether a level is muted: no pushes (and, for Agents, no waking on ordinary messages). A
 * person's unread count and mention badge are the same at every level. */
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
