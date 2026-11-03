import { m } from "#src/paraglide/messages";
import type {
  MobileDelay,
  NotificationPreviewMode,
} from "#src/features/notifications/notification-settings.schemas";

/**
 * The rules of a person's account notification settings (task #467), as Raft 1.0.60's
 * `packages/shared/src/notifications.ts` sets them: a pause and quiet hours suppress a
 * notification, a phone's waits while the computer is in use, and the preview decides what is
 * shown. Pure: the caller reads the settings, the time zone and the computer's activity.
 */

export type NotificationSettings = {
  pausedUntil: Date | null;
  /** Minutes after local midnight; the window may cross midnight. */
  quietHours: { enabled: boolean; startMinute: number; endMinute: number };
  previewMode: NotificationPreviewMode;
  sound: boolean;
  mobileDelay: MobileDelay;
  version: number;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  pausedUntil: null,
  quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 8 * 60 },
  previewMode: "full",
  sound: true,
  mobileDelay: "inactive",
  version: 0,
};

/** Input this recent counts as using the computer. */
export const ACTIVE_INPUT_WINDOW_MS = 3 * 60_000;
/** A focused CoForge page on a computer reports its input this often. */
export const PRESENCE_HEARTBEAT_MS = 60_000;
/** With no report for this long, nobody is at the computer. */
export const PRESENCE_ONLINE_TTL_MS = 150_000;

/** The computer's last reported input, and when it was reported; none when nothing is fresh. */
export type ComputerActivity = { lastInputAt: Date; reportedAt: Date };

/** Why nothing is shown now, on any device: a pause, or quiet hours in `timeZone`. */
export function suppression(
  settings: NotificationSettings,
  timeZone: string,
  now: Date,
): "paused" | "quiet_hours" | null {
  if (settings.pausedUntil && now < settings.pausedUntil) return "paused";
  const { enabled, startMinute, endMinute } = settings.quietHours;
  if (!enabled || startMinute === endMinute) return null;
  const local = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(
    knownZone(timeZone),
  );
  const minute = local.hour * 60 + local.minute;
  const inside =
    startMinute < endMinute
      ? minute >= startMinute && minute < endMinute
      : minute >= startMinute || minute < endMinute;
  return inside ? "quiet_hours" : null;
}

function knownZone(timeZone: string) {
  try {
    Temporal.Now.instant().toZonedDateTimeISO(timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

const IDLE_MINUTES: Record<Exclude<MobileDelay, "immediate" | "inactive">, number> = {
  idle_1m: 1,
  idle_2m: 2,
  idle_5m: 5,
  idle_10m: 10,
};

/**
 * When a phone's notification may ring, or null for now. It waits only while the computer is in
 * use: input within `ACTIVE_INPUT_WINDOW_MS`, reported within `PRESENCE_ONLINE_TTL_MS`. A computer
 * that stopped reporting has nobody at it, whatever the delay says.
 */
export function mobileDeferredUntil(
  delay: MobileDelay,
  activity: ComputerActivity | null,
  now: Date,
): Date | null {
  if (delay === "immediate" || !activity) return null;
  const goneAt = activity.reportedAt.getTime() + PRESENCE_ONLINE_TTL_MS;
  if (goneAt <= now.getTime()) return null;
  const idleAfter = delay === "inactive" ? ACTIVE_INPUT_WINDOW_MS : IDLE_MINUTES[delay] * 60_000;
  const due = Math.min(activity.lastInputAt.getTime() + idleAfter, goneAt);
  return due > now.getTime() ? new Date(due) : null;
}

type Locale = "en" | "zh-CN";

/** The title and body a notification shows under `mode`. A server notice has no sender, so
 * `sender` hides its text too. */
export function previewNotification(
  notification: { title: string; body: string; sender: string | null },
  mode: NotificationPreviewMode,
  locale: Locale,
): { title: string; body: string } {
  if (mode === "full") return { title: notification.title, body: notification.body };
  if (mode === "sender" && notification.sender)
    return {
      title: notification.title,
      body: m.notification_preview_sender({ sender: notification.sender }, { locale }),
    };
  if (mode === "sender")
    return { title: notification.title, body: m.notification_preview_hidden_body({}, { locale }) };
  return {
    title: m.notification_preview_hidden_title({}, { locale }),
    body: m.notification_preview_hidden_body({}, { locale }),
  };
}
