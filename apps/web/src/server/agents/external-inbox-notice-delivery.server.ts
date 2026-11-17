import { createHmac } from "node:crypto";
import type { WakeHint } from "@lrm/coforge-sdk/agent";
import { isWebhookEndpoint } from "#src/features/apps/app-webhook";
import { WEBHOOK_REQUEST_TIMEOUT_MS } from "#src/server/app-notifications/webhook-delivery.server";
import {
  UnsupportedEgressSchemeError,
  type OutboundEgress,
} from "#src/server/egress/outbound-egress.server";
import {
  REJECTED_DELAY_SECONDS,
  TRANSIENT_CAP_SECONDS,
  classify,
  noticeText,
  transient,
  type Outcome,
} from "./external-inbox-notice-outcome.server";
import type { ExternalInboxNoticeJob } from "./external-inbox-notice-queue.server";
import type { PushWebhookSealer } from "./external-push-webhook-secret.server";
import type {
  PushAttemptUpdate,
  PushDisabledReason,
  PushWebhookRow,
  PushWebhookStore,
} from "./external-push-webhook-store";

export const NOTICE_SCHEMA = "coforge-agent-inbox-notice.v1";

export const REJECTION_LIMIT = 3;

export type NoticeDeliveryDependencies = {
  egress: Pick<OutboundEgress, "sendToAny">;
  sealer: () => Promise<PushWebhookSealer | undefined>;
  listHints: (scope: { workspaceId: string; agentId: string }) => Promise<WakeHint[]>;
  reschedule: (agentId: string, noticeId: string, delaySeconds: number) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
};

export class ExternalInboxNoticeDelivery {
  private readonly now: () => Date;

  constructor(
    private readonly store: PushWebhookStore,
    private readonly deps: NoticeDeliveryDependencies,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  handle = async (jobs: { data: ExternalInboxNoticeJob }[]): Promise<void> => {
    for (const job of jobs) await this.deliver(job.data);
  };

  async deliver(job: ExternalInboxNoticeJob): Promise<void> {
    const target = await this.store.deliveryTarget(job.agentId);
    if (!target || !target.row.enabled) return;
    const { row, agent } = target;
    const at = this.now();
    if (agent.deletedAt || agent.stoppedAt || agent.hosting !== "external") {
      await this.disable(row, "agent_unavailable");
      return;
    }
    if (row.retryAt && row.retryAt > at && row.retryNoticeId !== job.noticeId) return;
    if (!isWebhookEndpoint(row.url)) {
      await this.disable(row, "endpoint_invalid");
      return;
    }
    const sealer = await this.deps.sealer();
    if (!sealer) return;
    const hints = await this.deps.listHints({
      workspaceId: agent.workspaceId,
      agentId: row.agentId,
    });
    if (hints.length === 0) {
      if (row.retryNoticeId) await this.store.record(row.agentId, row.revision, this.cleared());
      return;
    }
    const noticeId = row.retryNoticeId ?? job.noticeId;
    const body = JSON.stringify({
      schema: NOTICE_SCHEMA,
      noticeId,
      recipientAgentId: row.agentId,
      occurredAt: at.toISOString(),
      text: noticeText(hints),
      targets: hints,
    });
    let secret: string;
    try {
      secret = await sealer.open(row.agentId, row.secretSealed);
    } catch {
      await this.fail(row, noticeId, at, {
        kind: "retry",
        error: "secret_unreadable",
        delaySeconds: TRANSIENT_CAP_SECONDS,
      });
      return;
    }
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    let outcome: Outcome;
    try {
      const result = await this.deps.egress.sendToAny(
        row.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-CoForge-Signature-256": `sha256=${signature}`,
            "X-CoForge-Delivery-Id": noticeId,
          },
          body,
        },
        this.deps.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS,
      );
      outcome = classify(result, row.consecutiveFailures, at);
    } catch (error) {
      if (error instanceof UnsupportedEgressSchemeError) {
        await this.disable(row, "endpoint_invalid");
        return;
      }
      outcome = transient(error, row.consecutiveFailures);
    }
    if (outcome.kind === "delivered") {
      await this.store.record(row.agentId, row.revision, {
        ...this.cleared(),
        lastDeliveryAt: at,
      });
      return;
    }
    await this.fail(row, noticeId, at, outcome);
  }

  private cleared(): PushAttemptUpdate {
    return {
      lastError: null,
      consecutiveFailures: 0,
      rejectionStreak: 0,
      retryAt: null,
      retryNoticeId: null,
    };
  }

  private async fail(
    row: PushWebhookRow,
    noticeId: string,
    at: Date,
    outcome: Exclude<Outcome, { kind: "delivered" }>,
  ) {
    const rejected = outcome.kind === "rejected";
    const streak = rejected ? row.rejectionStreak + 1 : 0;
    const failures = row.consecutiveFailures + 1;
    if (rejected && streak >= REJECTION_LIMIT) {
      await this.store.record(row.agentId, row.revision, {
        lastError: outcome.error,
        consecutiveFailures: failures,
        rejectionStreak: streak,
        retryAt: null,
        retryNoticeId: null,
        disabledReason: "endpoint_rejected",
      });
      return;
    }
    const delaySeconds = rejected ? REJECTED_DELAY_SECONDS : outcome.delaySeconds;
    const written = await this.store.record(row.agentId, row.revision, {
      lastError: outcome.error,
      consecutiveFailures: failures,
      rejectionStreak: streak,
      retryAt: new Date(at.getTime() + delaySeconds * 1000),
      retryNoticeId: noticeId,
    });
    if (written) await this.deps.reschedule(row.agentId, noticeId, delaySeconds);
  }

  private async disable(row: PushWebhookRow, reason: PushDisabledReason) {
    await this.store.record(row.agentId, row.revision, {
      lastError: reason,
      consecutiveFailures: row.consecutiveFailures,
      rejectionStreak: row.rejectionStreak,
      retryAt: null,
      retryNoticeId: null,
      disabledReason: reason,
    });
  }
}
