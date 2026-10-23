import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaAppWebhookStore } from "#src/server/db/repositories/app-webhook.repositories.server";
import { OutboundEgress } from "#src/server/egress/outbound-egress.server";
import { WebhookDelivery } from "./webhook-delivery.server";
import { appNotificationsEnabled } from "./subscribers.server";
import { webhookKey } from "./webhook-secret.server";

/** Webhook delivery over PostgreSQL and the strict egress (public addresses only). `egress` is the
 * constructor seam a test uses to reach a receiver on this machine; production never passes it. */
export function createWebhookDelivery(egress: OutboundEgress = new OutboundEgress()) {
  return new WebhookDelivery(new PrismaAppWebhookStore(requireDatabaseClient()), {
    flagOn: appNotificationsEnabled,
    secretKey: webhookKey,
    egress,
  });
}
