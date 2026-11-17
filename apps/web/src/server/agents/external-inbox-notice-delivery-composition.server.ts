import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaExternalPushWebhookStore } from "#src/server/db/repositories/external-agent-push-webhook.repositories.server";
import { OutboundEgress } from "#src/server/egress/outbound-egress.server";
import { ExternalInboxNoticeDelivery } from "./external-inbox-notice-delivery.server";
import {
  sendExternalInboxNotice,
  sendExternalInboxProbe,
  type NoticeBoss,
} from "./external-inbox-notice-queue.server";
import { productionPushWebhookSealer } from "./external-push-webhook-secret.server";
import { listWakeHints } from "./external-wake-hints.server";

export function createExternalInboxNoticeDelivery(boss: NoticeBoss, egress = new OutboundEgress()) {
  const db = requireDatabaseClient();
  return new ExternalInboxNoticeDelivery(new PrismaExternalPushWebhookStore(db), {
    egress,
    sealer: productionPushWebhookSealer,
    listHints: (scope) => listWakeHints(db, scope),
    reschedule: (agentId, noticeId, delaySeconds) =>
      sendExternalInboxNotice(boss, agentId, { noticeId, delaySeconds }),
    scheduleProbe: (agentId, delaySeconds) => sendExternalInboxProbe(boss, agentId, delaySeconds),
    announce: (agentId) => sendExternalInboxNotice(boss, agentId),
  });
}

export async function resumeExternalPushProbes(boss: NoticeBoss, now = new Date()) {
  const pending = await new PrismaExternalPushWebhookStore(requireDatabaseClient()).pendingProbes();
  for (const { agentId, nextProbeAt } of pending)
    await sendExternalInboxProbe(
      boss,
      agentId,
      Math.max(0, Math.ceil((nextProbeAt.getTime() - now.getTime()) / 1000)),
    );
}
