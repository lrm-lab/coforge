import type { PgBoss } from "pg-boss";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaExternalPushWebhookStore } from "#src/server/db/repositories/external-agent-push-webhook.repositories.server";
import { OutboundEgress } from "#src/server/egress/outbound-egress.server";
import { ExternalInboxNoticeDelivery } from "./external-inbox-notice-delivery.server";
import { sendExternalInboxNotice } from "./external-inbox-notice-queue.server";
import { productionPushWebhookSealer } from "./external-push-webhook-secret.server";
import { listWakeHints } from "./external-wake-hints.server";

export function createExternalInboxNoticeDelivery(
  boss: Pick<PgBoss, "send">,
  egress = new OutboundEgress(),
) {
  const db = requireDatabaseClient();
  return new ExternalInboxNoticeDelivery(new PrismaExternalPushWebhookStore(db), {
    egress,
    sealer: productionPushWebhookSealer,
    listHints: (scope) => listWakeHints(db, scope),
    reschedule: (agentId, noticeId, delaySeconds) =>
      sendExternalInboxNotice(boss, agentId, { noticeId, delaySeconds }),
  });
}
