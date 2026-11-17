import { isWebhookEndpoint } from "#src/features/apps/app-webhook";
import {
  NonPublicAddressError,
  UnsupportedEgressSchemeError,
  type OutboundEgress,
} from "#src/server/egress/outbound-egress.server";
import { isStrongPushSecret, type PushWebhookSealer } from "./external-push-webhook-secret.server";
import type { PushRecovery } from "./external-push-recovery.server";
import type {
  PushDisabledReason,
  PushWebhookRow,
  PushWebhookStore,
} from "./external-push-webhook-store";

export class PushWebhookRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PushWebhookRefusal";
  }
}

export type PushWebhookView = {
  url: string;
  enabled: boolean;
  disabledReason: PushDisabledReason | null;
  lastDeliveryAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  recovery: PushRecovery | null;
};

export type ExternalPushWebhookDependencies = {
  egress: Pick<OutboundEgress, "resolveTarget">;
  sealer: () => Promise<PushWebhookSealer | undefined>;
  ensureQueue: () => Promise<boolean>;
  now?: () => Date;
};

const invalidUrl = () =>
  new PushWebhookRefusal("invalid_url", 400, "url must be an https URL without credentials");

function recoveryOf(row: PushWebhookRow): PushRecovery | null {
  if (row.enabled) return null;
  const probing = row.disabledReason === "endpoint_rejected" && row.nextProbeAt !== null;
  return {
    resumesOn: probing ? "probe_success" : "put",
    nextProbeAt: probing ? row.nextProbeAt : null,
    probeStoppedAt: row.probeStoppedAt,
  };
}

export class ExternalPushWebhooks {
  constructor(
    private readonly store: PushWebhookStore,
    private readonly deps: ExternalPushWebhookDependencies,
  ) {}

  async put(
    principal: { agentId: string; workspaceId: string },
    body: unknown,
  ): Promise<PushWebhookView> {
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const { url, secret } = input;
    if (!isWebhookEndpoint(url)) throw invalidUrl();
    if (!isStrongPushSecret(secret))
      throw new PushWebhookRefusal(
        "weak_secret",
        400,
        "secret must be at least 32 random bytes: 64 hex or 43 base64url characters",
      );
    try {
      await this.deps.egress.resolveTarget(url);
    } catch (error) {
      if (error instanceof NonPublicAddressError || error instanceof UnsupportedEgressSchemeError)
        throw new PushWebhookRefusal(
          "endpoint_not_public",
          400,
          "url must resolve only to public addresses",
        );
      throw new PushWebhookRefusal("endpoint_unresolvable", 400, "url could not be resolved");
    }
    const sealer = await this.deps.sealer();
    if (!sealer || !(await this.deps.ensureQueue()))
      throw new PushWebhookRefusal(
        "push_webhook_unavailable",
        503,
        "push webhooks are not available on this deployment",
      );
    await this.store.save({
      agentId: principal.agentId,
      workspaceId: principal.workspaceId,
      url,
      secretSealed: await sealer.seal(principal.agentId, secret),
    });
    const view = await this.get(principal.agentId);
    if (!view)
      throw new PushWebhookRefusal("push_webhook_unavailable", 503, "registration was not saved");
    return view;
  }

  async get(agentId: string): Promise<PushWebhookView | null> {
    const row = await this.store.find(agentId);
    if (!row) return null;
    return {
      url: row.url,
      enabled: row.enabled,
      disabledReason: row.disabledReason,
      lastDeliveryAt: row.lastDeliveryAt,
      lastError: row.lastError,
      consecutiveFailures: row.consecutiveFailures,
      recovery: recoveryOf(row),
    };
  }

  remove(agentId: string): Promise<boolean> {
    return this.store.remove(agentId);
  }
}
