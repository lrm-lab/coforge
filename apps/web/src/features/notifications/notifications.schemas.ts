import { z } from "zod";
import { DEVICE_KINDS } from "./notification-settings.schemas";

const base64Url = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .length(Math.ceil((bytes * 8) / 6));

function isSafePushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      value.startsWith("https://") &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export const browserNotificationPreferenceInput = z.object({
  enabled: z.boolean(),
});

export const browserPushSubscriptionInput = z.object({
  endpoint: z.string().max(4_096).refine(isSafePushEndpoint),
  expirationTime: z.number().int().positive().nullable(),
  keys: z.object({ p256dh: base64Url(65), auth: base64Url(16) }),
  // Whether this browser is a phone or a computer, and what Settings calls it (task #467); a
  // subscription without them is a computer, whose notifications never wait.
  deviceKind: z.enum(DEVICE_KINDS).optional(),
  deviceLabel: z.string().trim().min(1).max(80).optional(),
});

export const browserPushUnsubscribeInput = z.object({
  endpoint: z.string().max(4_096).refine(isSafePushEndpoint),
});

export const browserPushTestInput = browserPushUnsubscribeInput;

/** The in-page notification read: the viewer only ever asks about one message they were
 * just told about over realtime, never a list. */
export const messageNotificationInput = z.object({
  messageId: z.uuid(),
});
