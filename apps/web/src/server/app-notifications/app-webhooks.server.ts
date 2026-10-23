import { AppError } from "#src/lib/app-error";
import { canManageApps } from "#src/features/workspaces/workspace-roles";
import {
  APP_NOTIFICATIONS_OFF,
  APP_WEBHOOK_ENDPOINT_INVALID,
  APP_WEBHOOK_ENDPOINT_UNREACHABLE,
  APP_WEBHOOK_UNAVAILABLE,
  isWebhookEndpoint,
  webhookStatusOf,
  type WebhookStatus,
  WEBHOOK_SECRET_OVERLAP_HOURS,
} from "#src/features/apps/app-webhook";
import type { AppActor } from "#src/server/apps/app-registry.server";
import type { OutboundEgress } from "#src/server/egress/outbound-egress.server";
import {
  isEnabledWebhook,
  type AppWebhookStore,
  InstallationWebhookStatus,
  WebhookAppRef,
} from "./app-webhook-store";
import { deriveWebhookSecret, previousSecretValidUntil } from "./webhook-secret.server";

/** What the editor shows of an app's webhook: never a secret. */
export type AppWebhookView = {
  /** Off, Setup (switched on, no endpoint) or Enabled (delivering). */
  status: WebhookStatus;
  enabled: boolean;
  endpointUrl: string | null;
  revision: number;
  secretGeneration: number;
  /** While a rotation overlaps, until when the previous secret still signs; else null. */
  previousSecretValidUntil: Date | null;
  /** The app's installations in the caller's own Workspace, never another's. */
  installations: {
    installationId: string;
    workspaceId: string;
    status: InstallationWebhookStatus | null;
  }[];
};

/** The webhook and, when this call made a secret, the secret (`signingSecret`): shown once, never
 * read back. */
export type AppWebhookChange = { webhook: AppWebhookView; signingSecret?: string };

export type AppWebhookDependencies = {
  flagOn: (workspace: { id: string; slug: string }) => Promise<boolean>;
  /** Settles that `key` is the actor's Workspace's own app and the actor may manage apps
   * (`AppRegistry.requireOwnApp`); throws otherwise. */
  requireOwnApp: (actor: AppActor, key: string) => Promise<unknown>;
  /** The key secrets are derived from; none when the deployment has not configured one. */
  secretKey: () => string | undefined;
  egress: OutboundEgress;
  now?: () => Date;
};

/**
 * An app's signed webhook, behind the `app-notifications` flag: the Workspace's owners and admins
 * enable it by saving an endpoint, rotate its secret and disable it. A secret is returned once, by
 * the call that made it, and derived again only for signing. Every change bumps `revision` and
 * clears the delivery statuses, so a stop (`endpoint_rejected`, `retries_exhausted`, ...) never outlives the
 * endpoint it was about. Disabling is not gated by the flag or the key: removing the endpoint is
 * always allowed.
 */
export class AppWebhooks {
  private readonly now: () => Date;

  constructor(
    private readonly store: AppWebhookStore,
    private readonly deps: AppWebhookDependencies,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The app's webhook; `null` while the flag is off for the Workspace. */
  async read(actor: AppActor, key: string): Promise<AppWebhookView | null> {
    const app = await this.ownApp(actor, key);
    return (await this.deps.flagOn(app.workspace)) ? this.view(app) : null;
  }

  /** The webhook state of each of the actor's Workspace's apps that has one switched on, by key,
   * for the app list's badge; apps absent are Off. `null` for a plain member and while the flag
   * is off there: only owners and admins see it. */
  async workspaceStatuses(actor: AppActor): Promise<Map<string, WebhookStatus> | null> {
    const role = await this.store.memberRole(actor.workspaceId, actor.actorUserId);
    if (!role || !canManageApps(role)) return null;
    const workspace = await this.store.workspaceOf(actor.workspaceId);
    if (!workspace || !(await this.deps.flagOn(workspace))) return null;
    return this.store.statusesByAppKey(actor.workspaceId);
  }

  /** Switches the webhook on without an endpoint (Setup): nothing is delivered until
   * `save`. The secret generation moves on now, so an earlier secret is never valid again, but the
   * secret is shown by the first `save`, when the receiver is being configured. Enabling an
   * enabled webhook changes nothing. */
  async enable(actor: AppActor, key: string): Promise<AppWebhookChange> {
    const app = await this.ownApp(actor, key);
    await this.requireAvailable(app);
    if (!(await this.store.find(app.appId))?.enabled) {
      await this.store.change(app.appId, (current) => ({
        next: {
          enabled: true,
          endpointUrl: null,
          secretGeneration: current.secretGeneration + 1,
          previousSecretGeneration: null,
          previousSecretValidUntil: null,
        },
        result: undefined,
      }));
    }
    return { webhook: await this.view(app) };
  }

  /** Saves `endpointUrl`: it enables a disabled webhook, finishes a Setup one, or moves an enabled
   * one. The secret is in the answer only when the webhook had no endpoint before (the first
   * one of this generation). */
  async save(actor: AppActor, key: string, endpointUrl: unknown): Promise<AppWebhookChange> {
    const app = await this.ownApp(actor, key);
    await this.requireAvailable(app);
    if (!isWebhookEndpoint(endpointUrl)) {
      throw new AppError("INVALID_INPUT", { errorId: APP_WEBHOOK_ENDPOINT_INVALID });
    }
    await this.requirePublic(endpointUrl);
    const issued = await this.store.change(app.appId, (current) =>
      current.enabled
        ? {
            next: { ...current, endpointUrl },
            result: current.endpointUrl === null ? current.secretGeneration : undefined,
          }
        : {
            next: {
              enabled: true,
              endpointUrl,
              secretGeneration: current.secretGeneration + 1,
              previousSecretGeneration: null,
              previousSecretValidUntil: null,
            },
            result: current.secretGeneration + 1,
          },
    );
    return this.changed(app, issued);
  }

  /** Moves to the next secret generation; the previous one keeps signing for
   * `WEBHOOK_SECRET_OVERLAP_HOURS`. CONFLICT while the webhook is disabled. */
  async rotate(actor: AppActor, key: string): Promise<AppWebhookChange> {
    const app = await this.ownApp(actor, key);
    await this.requireAvailable(app);
    const validUntil = new Date(this.now().getTime() + WEBHOOK_SECRET_OVERLAP_HOURS * 3_600_000);
    const issued = await this.store.change(app.appId, (current) => {
      if (!isEnabledWebhook(current))
        throw new AppError("CONFLICT", { errorId: "app-webhook-disabled" });
      return {
        next: {
          ...current,
          secretGeneration: current.secretGeneration + 1,
          previousSecretGeneration: current.secretGeneration,
          previousSecretValidUntil: validUntil,
        },
        result: current.secretGeneration + 1,
      };
    });
    return this.changed(app, issued);
  }

  /** Removes the endpoint and the previous secret at once. Disabling a disabled webhook changes
   * nothing. */
  async disable(actor: AppActor, key: string): Promise<AppWebhookChange> {
    const app = await this.ownApp(actor, key);
    if ((await this.store.find(app.appId))?.enabled) {
      await this.store.change(app.appId, (current) => ({
        next: {
          ...current,
          enabled: false,
          endpointUrl: null,
          previousSecretGeneration: null,
          previousSecretValidUntil: null,
        },
        result: undefined,
      }));
    }
    return { webhook: await this.view(app) };
  }

  private async ownApp(actor: AppActor, key: string): Promise<WebhookAppRef> {
    await this.deps.requireOwnApp(actor, key);
    const app = await this.store.findApp(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    return app;
  }

  private async requireAvailable(app: WebhookAppRef): Promise<void> {
    if (!(await this.deps.flagOn(app.workspace))) {
      throw new AppError("ACCESS_DENIED", { errorId: APP_NOTIFICATIONS_OFF });
    }
    if (!this.deps.secretKey()) {
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: APP_WEBHOOK_UNAVAILABLE });
    }
  }

  /** The endpoint's host resolves, and only to public addresses; the same check runs again at
   * every delivery. */
  private async requirePublic(endpointUrl: string): Promise<void> {
    try {
      await this.deps.egress.resolveTarget(endpointUrl);
    } catch {
      throw new AppError("INVALID_INPUT", { errorId: APP_WEBHOOK_ENDPOINT_UNREACHABLE });
    }
  }

  private async changed(app: WebhookAppRef, issuedGeneration: number | undefined) {
    const key = this.deps.secretKey();
    return {
      webhook: await this.view(app),
      ...(issuedGeneration !== undefined && key
        ? { signingSecret: deriveWebhookSecret(key, app.appId, issuedGeneration) }
        : {}),
    };
  }

  private async view({ appId, workspace }: WebhookAppRef): Promise<AppWebhookView> {
    const [row, installations, statuses] = await Promise.all([
      this.store.find(appId),
      this.store.installations(appId, workspace.id),
      this.store.statuses(appId, workspace.id),
    ]);
    const byInstallation = new Map(statuses.map((status) => [status.installationId, status]));
    return {
      status: webhookStatusOf(row),
      enabled: row?.enabled ?? false,
      endpointUrl: row?.endpointUrl ?? null,
      revision: row?.revision ?? 0,
      secretGeneration: row?.secretGeneration ?? 0,
      previousSecretValidUntil: row ? previousSecretValidUntil(row, this.now()) : null,
      installations: installations.map(({ installationId, workspaceId }) => ({
        installationId,
        workspaceId,
        status: byInstallation.get(installationId) ?? null,
      })),
    };
  }
}
