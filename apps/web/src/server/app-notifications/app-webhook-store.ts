import type { WebhookDisabledReason } from "#src/features/apps/app-webhook";

/** An app's webhook row. `endpointUrl` is set exactly while `enabled`. */
export type WebhookRow = {
  appId: string;
  enabled: boolean;
  endpointUrl: string | null;
  secretGeneration: number;
  previousSecretGeneration: number | null;
  previousSecretValidUntil: Date | null;
  revision: number;
};

/** An enabled webhook with the endpoint it is enabled at. */
export type EnabledWebhookRow = WebhookRow & { enabled: true; endpointUrl: string };

export const isEnabledWebhook = (row: WebhookRow | null | undefined): row is EnabledWebhookRow =>
  !!row?.enabled && row.endpointUrl !== null;

/** How deliveries to one installation are going. Never holds a response body. */
export type InstallationWebhookStatus = {
  installationId: string;
  /** The webhook revision the status was written at; an older one is about another endpoint. */
  revision: number;
  lastAttemptAt: Date | null;
  lastDeliveryAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextAttemptAt: Date | null;
  /** Why deliveries stopped; `null` while they continue. */
  disabledReason: WebhookDisabledReason | null;
  /** When they stopped; set exactly when `disabledReason` is. */
  disabledAt: Date | null;
};

export type WebhookAppRef = { appId: string; workspace: { id: string; slug: string } };

/** What a delivery needs to know about an installation. */
export type DeliveryTarget = {
  installationId: string;
  appId: string;
  workspace: { id: string; slug: string };
  webhook: WebhookRow | null;
  status: InstallationWebhookStatus | null;
};

/** The outcome of one delivery attempt, written only while the webhook is still at `revision`. */
export type DeliveryAttempt = {
  installationId: string;
  revision: number;
  at: Date;
  outcome:
    | { kind: "delivered" }
    /** Not sent, and not counted as a failure (`error` says why). */
    | { kind: "skipped"; error: string }
    | {
        kind: "failed";
        error: string;
        /** Failed attempts of this delivery so far; set, never incremented, so an attempt
         * recorded twice counts once. */
        consecutiveFailures: number;
        nextAttemptAt: Date | null;
        disabledReason: WebhookDisabledReason | null;
      };
};

/** What the webhook module needs of PostgreSQL (`PrismaAppWebhookStore`). */
export interface AppWebhookStore {
  /** The app `key` that `ownerWorkspaceId` owns. */
  findApp(ownerWorkspaceId: string, key: string): Promise<WebhookAppRef | undefined>;
  find(appId: string): Promise<WebhookRow | undefined>;
  /** The delivery statuses of the app's installations in one Workspace. */
  statuses(appId: string, workspaceId: string): Promise<InstallationWebhookStatus[]>;
  /** The app's installations in one Workspace. */
  installations(
    appId: string,
    workspaceId: string,
  ): Promise<{ installationId: string; workspaceId: string }[]>;
  /** Under a lock on the app's row (created disabled at generation 0 when there is none): lets
   * `decide` choose the next state, writes it with `revision` one higher, deletes every
   * installation's status, and returns what `decide` returned. */
  change<Result>(
    appId: string,
    decide: (current: WebhookRow) => {
      next: Omit<WebhookRow, "appId" | "revision">;
      result: Result;
    },
  ): Promise<Result>;
  findForDelivery(installationId: string): Promise<DeliveryTarget | undefined>;
  /** Whether the outcome was written: `false` once the webhook is past `attempt.revision`. */
  recordAttempt(attempt: DeliveryAttempt): Promise<boolean>;
}
