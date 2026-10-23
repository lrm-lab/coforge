import { webhookStatusOf, type WebhookDisabledReason } from "#src/features/apps/app-webhook";
import type {
  AppWebhookStore,
  DeliveryAttempt,
  DeliveryTarget,
  InstallationWebhookStatus,
  WebhookAppRef,
  WebhookRow,
} from "#src/server/app-notifications/app-webhook-store";
import { inTransaction, type DatabaseScope } from "#src/server/db/transaction.server";

const WEBHOOK = {
  appId: true,
  enabled: true,
  endpointUrl: true,
  secretGeneration: true,
  previousSecretGeneration: true,
  previousSecretValidUntil: true,
  revision: true,
} as const;

const STATUS = {
  installationId: true,
  revision: true,
  disabledAt: true,
  lastAttemptAt: true,
  lastDeliveryAt: true,
  lastError: true,
  consecutiveFailures: true,
  nextAttemptAt: true,
  disabledReason: true,
} as const;

const toStatus = (row: {
  installationId: string;
  revision: number;
  disabledAt: Date | null;
  lastAttemptAt: Date | null;
  lastDeliveryAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextAttemptAt: Date | null;
  disabledReason: string | null;
}): InstallationWebhookStatus => ({
  ...row,
  // `app_installation_webhook_statuses_check` limits the column to these values.
  disabledReason: row.disabledReason as WebhookDisabledReason | null,
});

/** An app's webhook row and the delivery status of each of its installations. A change locks the
 * row, writes it and deletes the statuses in one transaction; an attempt's outcome is written only
 * while the webhook is still at the revision the attempt was made with. Who may change it, the
 * endpoint rules and the delivery policy stay in `server/app-notifications/`. */
export class PrismaAppWebhookStore implements AppWebhookStore {
  constructor(private readonly db: DatabaseScope) {}

  async findApp(ownerWorkspaceId: string, key: string): Promise<WebhookAppRef | undefined> {
    const app = await this.db.app.findFirst({
      where: { key, ownerWorkspaceId },
      select: { id: true, ownerWorkspace: { select: { id: true, slug: true } } },
    });
    return app ? { appId: app.id, workspace: app.ownerWorkspace } : undefined;
  }

  async find(appId: string): Promise<WebhookRow | undefined> {
    return (
      (await this.db.appWebhook.findUnique({ where: { appId }, select: WEBHOOK })) ?? undefined
    );
  }

  async statuses(appId: string, workspaceId: string): Promise<InstallationWebhookStatus[]> {
    const rows = await this.db.appInstallationWebhookStatus.findMany({
      where: { installation: { appId, workspaceId } },
      select: STATUS,
      orderBy: { installationId: "asc" },
    });
    return rows.map(toStatus);
  }

  async statusesByAppKey(workspaceId: string) {
    const rows = await this.db.appInstallation.findMany({
      where: { workspaceId, app: { ownerWorkspaceId: workspaceId, webhook: { enabled: true } } },
      select: {
        app: { select: { key: true, webhook: { select: { enabled: true, endpointUrl: true } } } },
      },
    });
    return new Map(rows.map((row) => [row.app.key, webhookStatusOf(row.app.webhook)] as const));
  }

  async workspaceOf(workspaceId: string) {
    return (
      (await this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, slug: true },
      })) ?? undefined
    );
  }

  async memberRole(workspaceId: string, userId: string) {
    const member = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return member?.role;
  }

  async installations(appId: string, workspaceId: string) {
    const rows = await this.db.appInstallation.findMany({
      where: { appId, workspaceId },
      select: { id: true, workspaceId: true },
      orderBy: { id: "asc" },
    });
    return rows.map((row) => ({ installationId: row.id, workspaceId: row.workspaceId }));
  }

  async change<Result>(
    appId: string,
    decide: (current: WebhookRow) => {
      next: Omit<WebhookRow, "appId" | "revision">;
      result: Result;
    },
  ): Promise<Result> {
    return inTransaction(this.db, async (tx) => {
      await tx.$executeRaw`INSERT INTO app_webhooks ("appId", "updatedAt") VALUES (${appId}::uuid, now()) ON CONFLICT ("appId") DO NOTHING`;
      await tx.$queryRaw`SELECT 1 FROM app_webhooks WHERE "appId" = ${appId}::uuid FOR UPDATE`;
      const current = await tx.appWebhook.findUniqueOrThrow({ where: { appId }, select: WEBHOOK });
      const { next, result } = decide(current);
      await tx.appWebhook.update({
        where: { appId },
        data: { ...next, revision: current.revision + 1 },
      });
      await tx.appInstallationWebhookStatus.deleteMany({ where: { installation: { appId } } });
      return result;
    });
  }

  async findForDelivery(installationId: string): Promise<DeliveryTarget | undefined> {
    const row = await this.db.appInstallation.findUnique({
      where: { id: installationId },
      select: {
        id: true,
        appId: true,
        workspace: { select: { id: true, slug: true } },
        app: { select: { webhook: { select: WEBHOOK } } },
        webhookStatus: { select: STATUS },
      },
    });
    if (!row) return undefined;
    return {
      installationId: row.id,
      appId: row.appId,
      workspace: row.workspace,
      webhook: row.app.webhook,
      status: row.webhookStatus ? toStatus(row.webhookStatus) : null,
    };
  }

  async recordAttempt(attempt: DeliveryAttempt): Promise<boolean> {
    const { installationId, revision, at, outcome } = attempt;
    // Each statement writes only while the installation's app webhook is still at `revision`.
    let written: number;
    if (outcome.kind === "delivered") {
      written = await this.db.$executeRaw`
        INSERT INTO app_installation_webhook_statuses
          ("installationId", "revision", "lastAttemptAt", "lastDeliveryAt", "lastError", "consecutiveFailures", "nextAttemptAt", "disabledReason", "disabledAt", "updatedAt")
        SELECT i.id, w.revision, ${at}::timestamp, ${at}::timestamp, NULL, 0, NULL, NULL, NULL, ${at}::timestamp
        FROM app_installations i JOIN app_webhooks w ON w."appId" = i."appId"
        WHERE i.id = ${installationId}::uuid AND w.revision = ${revision}
        ON CONFLICT ("installationId") DO UPDATE SET
          "revision" = ${revision}, "lastAttemptAt" = ${at}::timestamp, "lastDeliveryAt" = ${at}::timestamp,
          "lastError" = NULL, "consecutiveFailures" = 0, "nextAttemptAt" = NULL,
          "disabledReason" = NULL, "disabledAt" = NULL, "updatedAt" = ${at}::timestamp`;
    } else if (outcome.kind === "skipped") {
      written = await this.db.$executeRaw`
        INSERT INTO app_installation_webhook_statuses
          ("installationId", "revision", "lastAttemptAt", "lastError", "consecutiveFailures", "nextAttemptAt", "updatedAt")
        SELECT i.id, w.revision, ${at}::timestamp, ${outcome.error}::text, 0, NULL, ${at}::timestamp
        FROM app_installations i JOIN app_webhooks w ON w."appId" = i."appId"
        WHERE i.id = ${installationId}::uuid AND w.revision = ${revision}
        ON CONFLICT ("installationId") DO UPDATE SET
          "revision" = ${revision}, "lastAttemptAt" = ${at}::timestamp, "lastError" = ${outcome.error}::text,
          "nextAttemptAt" = NULL, "updatedAt" = ${at}::timestamp`;
    } else {
      const stoppedAt = outcome.disabledReason ? at : null;
      written = await this.db.$executeRaw`
        INSERT INTO app_installation_webhook_statuses
          ("installationId", "revision", "lastAttemptAt", "lastError", "consecutiveFailures", "nextAttemptAt", "disabledReason", "disabledAt", "updatedAt")
        SELECT i.id, w.revision, ${at}::timestamp, ${outcome.error}::text, ${outcome.consecutiveFailures}::int,
          ${outcome.nextAttemptAt}::timestamp, ${outcome.disabledReason}::text, ${stoppedAt}::timestamp, ${at}::timestamp
        FROM app_installations i JOIN app_webhooks w ON w."appId" = i."appId"
        WHERE i.id = ${installationId}::uuid AND w.revision = ${revision}
        ON CONFLICT ("installationId") DO UPDATE SET
          "revision" = ${revision}, "lastAttemptAt" = ${at}::timestamp, "lastError" = ${outcome.error}::text,
          "consecutiveFailures" = ${outcome.consecutiveFailures}::int,
          "nextAttemptAt" = ${outcome.nextAttemptAt}::timestamp,
          "disabledReason" = ${outcome.disabledReason}::text, "disabledAt" = ${stoppedAt}::timestamp,
          "updatedAt" = ${at}::timestamp`;
    }
    return written > 0;
  }
}
