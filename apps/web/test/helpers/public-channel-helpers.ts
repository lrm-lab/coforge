import type { MessageWebPushNotification } from "#src/server/notifications/web-push-notifications.server";

export const CHANNEL_MEMBER_CONTEXT = "[CoForge current channel role: member; coordinator=none]";

/** Flattens every recipient's browser subscriptions, matching the earlier assertions this
 * suite made directly against `notificationForMessage`'s old flat `subscriptions` field. */
export function subscriptionsOf(notification: MessageWebPushNotification | null) {
  return notification?.recipients.flatMap((recipient) => recipient.subscriptions) ?? [];
}
