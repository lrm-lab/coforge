import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaExternalPushWebhookStore } from "#src/server/db/repositories/external-agent-push-webhook.repositories.server";
import {
  isAppNotificationQueueStarted,
  startAppNotificationQueue,
} from "#src/server/app-notifications/app-notification-queue.server";
import { OutboundEgress } from "#src/server/egress/outbound-egress.server";
import { productionPushWebhookSealer } from "./external-push-webhook-secret.server";
import { ExternalPushWebhooks } from "./external-push-webhooks.server";

async function ensureQueue(): Promise<boolean> {
  if (isAppNotificationQueueStarted()) return true;
  try {
    await startAppNotificationQueue();
    return true;
  } catch {
    return false;
  }
}

export function createExternalPushWebhooks(egress = new OutboundEgress()) {
  return new ExternalPushWebhooks(new PrismaExternalPushWebhookStore(requireDatabaseClient()), {
    egress,
    sealer: productionPushWebhookSealer,
    ensureQueue,
  });
}
