import type { AppNotificationEvent } from "./app-notification-event";

/** Holds one job per recorded event, written in the domain transaction that caused it. */
export const APP_NOTIFICATION_EVENT_QUEUE = "app-notification-event";
/** Holds one job per (event, installation) the event worker found subscribed. */
export const APP_NOTIFICATION_DELIVERY_QUEUE = "app-notification-delivery";

/** Delivery jobs call a third party that may be down: retry with backoff, 5 s growing to a day at
 * most, 16 retries after the first attempt (seconds). An attempt that runs past a minute is
 * expired and retried. pg-boss waits between 1x and 2x of `retryDelay * 2^retryCount` (the
 * retry count of the attempt that failed), at most `retryDelayMax`. */
export const DELIVERY_QUEUE_OPTIONS = {
  retryLimit: 16,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 86_400,
  expireInSeconds: 60,
};

/** The earliest a retry can run after attempt `retryCount` (0 for the first) failed at `at`: the
 * low end of the wait pg-boss draws from `DELIVERY_QUEUE_OPTIONS`. */
export function earliestDeliveryRetryAt(retryCount: number, at: Date): Date {
  const seconds = Math.min(
    DELIVERY_QUEUE_OPTIONS.retryDelayMax,
    DELIVERY_QUEUE_OPTIONS.retryDelay * 2 ** retryCount,
  );
  return new Date(at.getTime() + seconds * 1_000);
}

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
