import type {
  AppInstallationSetupStore,
  InstallationSetupRow,
} from "#src/server/app-installation-setup/app-installation-setup.server";
import { findAppMember } from "#src/server/db/repositories/app.repositories.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";

const SETUP = {
  id: true,
  workspaceId: true,
  setupCompletedRevision: true,
  setupCompletedAt: true,
  workspace: { select: { slug: true } },
  app: {
    select: {
      key: true,
      ownerWorkspaceId: true,
      setupUrl: true,
      setupDescription: true,
      setupRevision: true,
    },
  },
} as const;

type SetupRow = {
  id: string;
  workspaceId: string;
  setupCompletedRevision: number | null;
  setupCompletedAt: Date | null;
  workspace: { slug: string };
  app: {
    key: string;
    ownerWorkspaceId: string;
    setupUrl: string | null;
    setupDescription: string;
    setupRevision: number;
  };
};

const toSetupRow = (row: SetupRow): InstallationSetupRow => ({
  installationId: row.id,
  appKey: row.app.key,
  ownerWorkspaceId: row.app.ownerWorkspaceId,
  workspaceId: row.workspaceId,
  workspaceSlug: row.workspace.slug,
  url: row.app.setupUrl,
  description: row.app.setupDescription,
  revision: row.app.setupRevision,
  completedRevision: row.setupCompletedRevision,
  completedAt: row.setupCompletedAt,
});

/** Installation setup rows. The declaration is one statement and a report one compare-and-set on
 * the app's `setupRevision`, each in the caller's transaction when `db` is one. Who may write, and
 * the rules of a declaration, stay in `server/app-installation-setup/`. */
export class PrismaAppInstallationSetupStore implements AppInstallationSetupStore {
  constructor(private readonly db: DatabaseScope) {}

  findMember(workspaceId: string, userId: string) {
    return findAppMember(this.db, workspaceId, userId);
  }

  async listInstalled(workspaceId: string) {
    const rows = await this.db.appInstallation.findMany({ where: { workspaceId }, select: SETUP });
    return rows.map(toSetupRow);
  }

  async findInstalled(workspaceId: string, key: string) {
    const row = await this.db.appInstallation.findFirst({
      where: { workspaceId, app: { key } },
      select: SETUP,
    });
    return row ? toSetupRow(row) : undefined;
  }

  async findInstallation(id: string) {
    const row = await this.db.appInstallation.findUnique({ where: { id }, select: SETUP });
    return row ? toSetupRow(row) : undefined;
  }

  async declare(input: {
    ownerWorkspaceId: string;
    key: string;
    url: string | null;
    description: string;
  }) {
    // The SET expressions read the stored row, so the comparison and the bump are one atomic step.
    const count = await this.db.$executeRaw`
      UPDATE "apps"
      SET "setupRevision" = "setupRevision" + (CASE WHEN "setupUrl" IS DISTINCT FROM ${input.url}::TEXT THEN 1 ELSE 0 END),
          "setupUrl" = ${input.url}::TEXT,
          "setupDescription" = ${input.description}
      WHERE "key" = ${input.key} AND "ownerWorkspaceId" = ${input.ownerWorkspaceId}::uuid`;
    return count === 1;
  }

  async record(input: { installationId: string; revision: number; complete: boolean; at: Date }) {
    // A completion for a revision the app has since left is harmless: the status compares it with
    // the app's current revision, so it reads as pending.
    const count = input.complete
      ? await this.db.$executeRaw`
          UPDATE "app_installations" AS installation
          SET "setupCompletedAt" = CASE
                WHEN installation."setupCompletedRevision" IS NOT DISTINCT FROM ${input.revision}::INTEGER
                THEN installation."setupCompletedAt"
                ELSE ${input.at}::TIMESTAMP(3)
              END,
              "setupCompletedRevision" = ${input.revision}::INTEGER
          FROM "apps" AS app
          WHERE installation."id" = ${input.installationId}::uuid
            AND app."id" = installation."appId"
            AND app."setupUrl" IS NOT NULL
            AND app."setupRevision" = ${input.revision}::INTEGER`
      : await this.db.$executeRaw`
          UPDATE "app_installations" AS installation
          SET "setupCompletedAt" = NULL, "setupCompletedRevision" = NULL
          FROM "apps" AS app
          WHERE installation."id" = ${input.installationId}::uuid
            AND app."id" = installation."appId"
            AND app."setupUrl" IS NOT NULL
            AND app."setupRevision" = ${input.revision}::INTEGER`;
    return count === 1;
  }
}
