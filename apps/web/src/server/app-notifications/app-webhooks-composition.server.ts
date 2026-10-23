import type { Prisma } from "#src/generated/prisma/client";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { PrismaAppWebhookStore } from "#src/server/db/repositories/app-webhook.repositories.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";
import { OutboundEgress } from "#src/server/egress/outbound-egress.server";
import { AppWebhooks } from "./app-webhooks.server";
import { appNotificationsEnabled } from "./subscribers.server";
import { webhookKey } from "./webhook-secret.server";

/** An app's webhook over PostgreSQL, behind the `app-notifications` flag. `db` may be an open
 * transaction. `egress` is the constructor seam a test uses; production never passes it. */
export function createAppWebhooks(
  db: DatabaseScope,
  egress: OutboundEgress = new OutboundEgress(),
) {
  const registry = createAppRegistry(db as Prisma.TransactionClient);
  return new AppWebhooks(new PrismaAppWebhookStore(db), {
    flagOn: appNotificationsEnabled,
    requireOwnApp: (actor, key) => registry.requireOwnApp(actor, key),
    secretKey: webhookKey,
    egress,
  });
}
