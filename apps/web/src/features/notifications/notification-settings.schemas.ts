import { z } from "zod";

/**
 * The account notification settings' values and the change a save sends (task #467), shared by
 * the Settings page and the server. Raft 1.0.60's option set.
 */

export const NOTIFICATION_PREVIEW_MODES = ["full", "sender", "hidden"] as const;
export type NotificationPreviewMode = (typeof NOTIFICATION_PREVIEW_MODES)[number];

export const MOBILE_DELAYS = [
  "immediate",
  "inactive",
  "idle_1m",
  "idle_2m",
  "idle_5m",
  "idle_10m",
] as const;
export type MobileDelay = (typeof MOBILE_DELAYS)[number];

export const DEVICE_KINDS = ["desktop", "mobile"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** A pause ends at most this far ahead. */
export const MAX_PAUSE_MS = 366 * 24 * 60 * 60_000;

const minuteOfDay = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 - 1);

/** A save: the version it was made from, and only the fields it changes. */
export const notificationSettingsChangeSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    changes: z
      .object({
        pausedUntil: z.iso.datetime().nullable(),
        quietHours: z
          .object({ enabled: z.boolean(), startMinute: minuteOfDay, endMinute: minuteOfDay })
          .strict()
          .refine((window) => window.startMinute !== window.endMinute, {
            message: "quiet hours start and end at different times",
          }),
        previewMode: z.enum(NOTIFICATION_PREVIEW_MODES),
        sound: z.boolean(),
        mobileDelay: z.enum(MOBILE_DELAYS),
      })
      .partial()
      .strict(),
  })
  .strict();
export type NotificationSettingsChange = z.infer<typeof notificationSettingsChangeSchema>;

/** A computer page's report: the last input it saw. */
export const activityReportSchema = z.object({ lastInputAt: z.iso.datetime() }).strict();
