import type { AppNotificationEvent } from "./app-notification-event";

/** Holds one job per recorded event, written in the domain transaction that caused it. */
export const APP_NOTIFICATION_EVENT_QUEUE = "app-notification-event";
/** Holds one job per (event, installation) the event worker found subscribed. */
export const APP_NOTIFICATION_DELIVERY_QUEUE = "app-notification-delivery";

export type AppNotificationDeliveryJob = {
  eventId: string;
  installationId: string;
  event: AppNotificationEvent;
};

/** Names the delivery job UUIDv5 namespace; a fixed value, so a rerun of the event worker derives
 * the ids it derived before and pg-boss drops the duplicate insert. */
const DELIVERY_NAMESPACE = "6d1f3c7e-8c1b-5a4e-9b0a-2f7d4e5a9c31";

export function appNotificationDeliveryJobId(eventId: string, installationId: string): string {
  return Bun.randomUUIDv5(`${eventId}:${installationId}`, DELIVERY_NAMESPACE);
}
