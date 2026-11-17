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
import { PROBE_TEXT, UNAUTHORIZED_GRACE_MS, nextProbe } from "./external-push-recovery.server";
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
  scheduleProbe: (agentId: string, delaySeconds: number) => Promise<void>;
  announce: (agentId: string) => Promise<void>;
  newId?: () => string;
  now?: () => Date;
  timeoutMs?: number;
};

type Sent = Outcome | { kind: "invalid" } | { kind: "unreadable" };

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
    if ("probe" in job) return this.probe(job.agentId);
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
    const sent = await this.send(sealer, row, { noticeId, at, text: noticeText(hints), hints });
    if (sent.kind === "invalid") {
      await this.disable(row, "endpoint_invalid");
      return;
    }
    if (sent.kind === "unreadable") {
      await this.fail(row, noticeId, at, {
        kind: "retry",
        error: "secret_unreadable",
        delaySeconds: TRANSIENT_CAP_SECONDS,
      });
      return;
    }
    if (sent.kind === "delivered") {
      await this.store.record(row.agentId, row.revision, {
        ...this.cleared(),
        lastDeliveryAt: at,
      });
      return;
    }
    await this.fail(row, noticeId, at, sent);
  }

  private async probe(agentId: string): Promise<void> {
    const target = await this.store.deliveryTarget(agentId);
    if (!target) return;
    const { row, agent } = target;
    const at = this.now();
    const { disabledAt, nextProbeAt } = row;
    if (row.enabled || row.disabledReason !== "endpoint_rejected" || !disabledAt || !nextProbeAt)
      return;
    if (nextProbeAt > at) return;
    if (agent.deletedAt || agent.stoppedAt || agent.hosting !== "external") {
      await this.disable(row, "agent_unavailable");
      return;
    }
    if (!isWebhookEndpoint(row.url)) {
      await this.disable(row, "endpoint_invalid");
      return;
    }
    const sealer = await this.deps.sealer();
    if (!sealer) return;
    const noticeId = (this.deps.newId ?? (() => crypto.randomUUID()))();
    const sent = await this.send(sealer, row, { noticeId, at, text: PROBE_TEXT, hints: [] });
    if (sent.kind === "invalid") {
      await this.disable(row, "endpoint_invalid");
      return;
    }
    if (sent.kind === "delivered") {
      const written = await this.store.record(row.agentId, row.revision, {
        ...this.cleared(),
        lastDeliveryAt: at,
        reenable: true,
        disabledAt: null,
        nextProbeAt: null,
        probeAttempts: null,
        probeStoppedAt: null,
      });
      if (written) await this.deps.announce(row.agentId);
      return;
    }
    const attempts = (row.probeAttempts ?? 0) + 1;
    const next = nextProbe(disabledAt, attempts, at);
    const written = await this.store.record(row.agentId, row.revision, {
      lastError: sent.kind === "unreadable" ? "secret_unreadable" : sent.error,
      consecutiveFailures: row.consecutiveFailures,
      rejectionStreak: row.rejectionStreak,
      unauthorizedSince: row.unauthorizedSince,
      retryAt: null,
      retryNoticeId: null,
      probeAttempts: attempts,
      nextProbeAt: next?.at ?? null,
      ...(next ? {} : { probeStoppedAt: at }),
    });
    if (written && next) await this.deps.scheduleProbe(row.agentId, next.delaySeconds);
  }

  private async send(
    sealer: PushWebhookSealer,
    row: PushWebhookRow,
    notice: { noticeId: string; at: Date; text: string; hints: WakeHint[] },
  ): Promise<Sent> {
    const body = JSON.stringify({
      schema: NOTICE_SCHEMA,
      noticeId: notice.noticeId,
      recipientAgentId: row.agentId,
      occurredAt: notice.at.toISOString(),
      text: notice.text,
      targets: notice.hints,
    });
    let secret: string;
    try {
      secret = await sealer.open(row.agentId, row.secretSealed);
    } catch {
      return { kind: "unreadable" };
    }
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    try {
      const result = await this.deps.egress.sendToAny(
        row.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-CoForge-Signature-256": `sha256=${signature}`,
            "X-CoForge-Delivery-Id": notice.noticeId,
          },
          body,
        },
        this.deps.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS,
      );
      return classify(result, row.consecutiveFailures, notice.at);
    } catch (error) {
      if (error instanceof UnsupportedEgressSchemeError) return { kind: "invalid" };
      return transient(error, row.consecutiveFailures);
    }
  }

  private cleared(): PushAttemptUpdate {
    return {
      lastError: null,
      consecutiveFailures: 0,
      rejectionStreak: 0,
      unauthorizedSince: null,
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
    const unauthorized = rejected && outcome.status === 401;
    const continuing =
      rejected && row.rejectionStreak > 0 && (row.unauthorizedSince !== null) === unauthorized;
    const streak = rejected ? (continuing ? row.rejectionStreak : 0) + 1 : 0;
    const unauthorizedSince = unauthorized ? (continuing ? row.unauthorizedSince : at) : null;
    const failures = row.consecutiveFailures + 1;
    const turnsOff =
      streak >= REJECTION_LIMIT &&
      (!unauthorizedSince || at.getTime() - unauthorizedSince.getTime() >= UNAUTHORIZED_GRACE_MS);
    if (rejected && turnsOff) {
      const first = nextProbe(at, 0, at);
      const written = await this.store.record(row.agentId, row.revision, {
        lastError: outcome.error,
        consecutiveFailures: failures,
        rejectionStreak: streak,
        unauthorizedSince,
        retryAt: null,
        retryNoticeId: null,
        disabledReason: "endpoint_rejected",
        disabledAt: at,
        probeAttempts: 0,
        probeStoppedAt: null,
        nextProbeAt: first?.at ?? null,
      });
      if (written && first) await this.deps.scheduleProbe(row.agentId, first.delaySeconds);
      return;
    }
    const delaySeconds = rejected ? REJECTED_DELAY_SECONDS : outcome.delaySeconds;
    const written = await this.store.record(row.agentId, row.revision, {
      lastError: outcome.error,
      consecutiveFailures: failures,
      rejectionStreak: streak,
      unauthorizedSince,
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
      unauthorizedSince: row.unauthorizedSince,
      retryAt: null,
      retryNoticeId: null,
      disabledReason: reason,
      disabledAt: this.now(),
      nextProbeAt: null,
    });
  }
}
