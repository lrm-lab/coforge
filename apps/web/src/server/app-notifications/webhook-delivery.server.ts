import { isWebhookEndpoint, type WebhookDisabledReason } from "#src/features/apps/app-webhook";
import {
  EgressProxyConfiguredError,
  NonPublicAddressError,
  UnsupportedEgressSchemeError,
  type OutboundEgress,
} from "#src/server/egress/outbound-egress.server";
import {
  DELIVERY_QUEUE_OPTIONS,
  earliestDeliveryRetryAt,
  type AppNotificationDeliveryJob,
} from "./app-notification-jobs";
import { isEnabledWebhook, type AppWebhookStore } from "./app-webhook-store";
import { signingSecrets } from "./webhook-secret.server";
import { signedWebhookRequest, webhookBody } from "./webhook-signing.server";

/** How long one POST may take, all validated addresses tried together. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 15_000;

/** The `lastError` of a delivery skipped because the deployment has no signing key. */
export const KEY_UNAVAILABLE = "key_unavailable";

/** An attempt failed in a way pg-boss should retry; the message is only a short classifier
 * (`http_503`, `timeout`, ...), never anything the endpoint answered. */
export class WebhookDeliveryFailed extends Error {
  constructor(readonly classifier: string) {
    super(classifier);
    this.name = "WebhookDeliveryFailed";
  }
}

/** The part of a pg-boss delivery job the handler uses. */
export type DeliveryJob = { id: string; retryCount: number; data: AppNotificationDeliveryJob };

export type WebhookDeliveryDependencies = {
  flagOn: (workspace: { id: string; slug: string }) => Promise<boolean>;
  secretKey: () => string | undefined;
  egress: OutboundEgress;
  now?: () => Date;
  timeoutMs?: number;
};

function classify(error: unknown): string {
  if (error instanceof NonPublicAddressError) return "address_not_public";
  if (error instanceof EgressProxyConfiguredError) return "proxy_configured";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "network";
}

/** Whether the missing-key notice was already logged since the key was last present. */
let keyUnavailableLogged = false;

/**
 * Sends one delivery job to its app's webhook (docs/app-notifications/http-delivery.md). It
 * completes the job without sending when the installation or the webhook is gone, the flag is
 * off, deliveries to the installation have stopped, or the deployment has no signing key
 * (`key_unavailable`: recorded and logged once, never a stop; the event is not delivered later).
 * Otherwise it re-resolves the endpoint, signs the event and POSTs it without following a
 * redirect: a 2xx is delivered; 410 stops deliveries to the installation (`endpoint_rejected`);
 * an event over the size limit or a stored endpoint the rules no longer accept stops them too
 * (`payload_too_large`, `endpoint_invalid`), because a retry cannot change either; any other
 * outcome throws so pg-boss retries, and on the last retry stops them (`retries_exhausted`). It
 * keeps no response body or secret.
 */
export class WebhookDelivery {
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(
    private readonly store: Pick<AppWebhookStore, "findForDelivery" | "recordAttempt">,
    private readonly deps: WebhookDeliveryDependencies,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS;
  }

  /** The pg-boss handler: one job at a time, in order. */
  handle = async (jobs: DeliveryJob[]): Promise<void> => {
    for (const job of jobs) await this.deliver(job);
  };

  async deliver(job: DeliveryJob): Promise<void> {
    const { installationId } = job.data;
    const target = await this.store.findForDelivery(installationId);
    const webhook = target?.webhook;
    if (!target || !isEnabledWebhook(webhook)) return;
    // A status belongs to the revision it was written at; an older one is about another endpoint.
    if (target.status?.disabledReason && target.status.revision === webhook.revision) return;
    if (!(await this.deps.flagOn(target.workspace))) return;

    const { revision } = webhook;
    const at = this.now();
    const key = this.deps.secretKey();
    if (!key) {
      await this.skipForMissingKey(installationId, revision, at);
      return;
    }
    keyUnavailableLogged = false;

    const endpoint = webhook.endpointUrl;
    if (!isWebhookEndpoint(endpoint)) {
      await this.stop(job, revision, at, "endpoint_invalid", "endpoint_invalid");
      return;
    }
    let body: string;
    try {
      body = webhookBody(job.data.event, installationId);
    } catch {
      await this.stop(job, revision, at, "body_too_large", "payload_too_large");
      return;
    }
    const { headers } = signedWebhookRequest({
      messageId: `msg_${job.id}`,
      body,
      now: at,
      secrets: signingSecrets(key, target.appId, webhook, at),
    });

    let status: number;
    try {
      ({ status } = await this.deps.egress.sendToAny(
        endpoint,
        { method: "POST", headers, body },
        this.timeoutMs,
      ));
    } catch (error) {
      if (error instanceof UnsupportedEgressSchemeError) {
        await this.stop(job, revision, at, "endpoint_invalid", "endpoint_invalid");
        return;
      }
      return this.failed(job, revision, at, classify(error));
    }
    if (status >= 200 && status < 300) {
      await this.store.recordAttempt({
        installationId,
        revision,
        at,
        outcome: { kind: "delivered" },
      });
      return;
    }
    if (status === 410) {
      await this.stop(job, revision, at, "http_410", "endpoint_rejected");
      return;
    }
    return this.failed(job, revision, at, `http_${status}`);
  }

  private async skipForMissingKey(installationId: string, revision: number, at: Date) {
    if (!keyUnavailableLogged) {
      keyUnavailableLogged = true;
      console.error(JSON.stringify({ event: "app_notifications:webhook_key_unavailable" }));
    }
    await this.store.recordAttempt({
      installationId,
      revision,
      at,
      outcome: { kind: "skipped", error: KEY_UNAVAILABLE },
    });
  }

  /** Records a failed attempt. On the last retry it stops deliveries and completes the job;
   * before that it throws, and pg-boss runs the job again. */
  private async failed(job: DeliveryJob, revision: number, at: Date, error: string): Promise<void> {
    if (job.retryCount >= DELIVERY_QUEUE_OPTIONS.retryLimit) {
      await this.stop(job, revision, at, error, "retries_exhausted");
      return;
    }
    await this.store.recordAttempt({
      installationId: job.data.installationId,
      revision,
      at,
      outcome: {
        kind: "failed",
        error,
        consecutiveFailures: job.retryCount + 1,
        nextAttemptAt: earliestDeliveryRetryAt(job.retryCount, at),
        disabledReason: null,
      },
    });
    throw new WebhookDeliveryFailed(error);
  }

  private async stop(
    job: DeliveryJob,
    revision: number,
    at: Date,
    error: string,
    disabledReason: WebhookDisabledReason,
  ): Promise<void> {
    await this.store.recordAttempt({
      installationId: job.data.installationId,
      revision,
      at,
      outcome: {
        kind: "failed",
        error,
        consecutiveFailures: job.retryCount + 1,
        nextAttemptAt: null,
        disabledReason,
      },
    });
  }
}
