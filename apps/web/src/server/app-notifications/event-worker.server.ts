import type { Job, PgBoss } from "pg-boss";

import type { AppNotificationEvent } from "./app-notification-event";
import {
  APP_NOTIFICATION_DELIVERY_QUEUE,
  appNotificationDeliveryJobId,
  type AppNotificationDeliveryJob,
} from "./app-notification-jobs";
import { subscribersOf } from "./subscribers.server";
import { createWebhookDelivery } from "./webhook-delivery-composition.server";

/**
 * Turns each event job into one delivery job per subscribed installation. The delivery job ids are
 * derived from the event and the installation, so when this crashes halfway and pg-boss runs the
 * event again, the inserts that already happened are dropped as duplicates.
 */
export async function fanOutAppNotificationEvents(
  boss: PgBoss,
  jobs: Job<AppNotificationEvent>[],
): Promise<void> {
  for (const { data: event } of jobs) {
    const subscribers = await subscribersOf(event);
    if (subscribers.length === 0) continue;
    await boss.insert(
      APP_NOTIFICATION_DELIVERY_QUEUE,
      subscribers.map(({ installationId }) => ({
        id: appNotificationDeliveryJobId(event.id, installationId),
        data: { eventId: event.id, installationId, event } satisfies AppNotificationDeliveryJob,
      })),
    );
  }
}

/** The production delivery handler: signed HTTP delivery to each app's webhook
 * (`WebhookDelivery`), over the strict egress. */
export async function deliverAppNotifications(
  jobs: Job<AppNotificationDeliveryJob>[],
): Promise<void> {
  await createWebhookDelivery().handle(jobs);
}
