import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  AuthorizationStore,
  ConsentGrant,
  OfferedWorkspace,
} from "#src/server/authorization-server/authorization-endpoint.server";
import type { StoredAuthorizationCode } from "#src/server/authorization-server/authorization-codes.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";

/** The authorization endpoint's rows: apps as OIDC clients, the Workspaces each person may
 * authorize them in, consents and authorization codes. What a request may do stays in
 * `server/authorization-server/`. */
export class PrismaAuthorizationStore implements AuthorizationStore {
  constructor(private readonly db: PrismaClient) {}

  async findClient(key: string) {
    const app = await this.db.app.findUnique({
      where: { key },
      select: {
        id: true,
        key: true,
        name: true,
        homepageUrl: true,
        redirectUris: true,
        allowedScopes: true,
      },
    });
    return app ?? undefined;
  }

  async listOfferedWorkspaces(appId: string, userId: string) {
    const rows = await this.db.workspace.findMany({
      where: offered(appId, userId),
      select: workspaceWithConsent(appId, userId),
      orderBy: [{ name: "asc" }, { slug: "asc" }],
    });
    return rows.map(toOfferedWorkspace);
  }

  async findOfferedWorkspace(appId: string, userId: string, workspaceId: string) {
    const row = await this.db.workspace.findFirst({
      where: { id: workspaceId, ...offered(appId, userId) },
      select: workspaceWithConsent(appId, userId),
    });
    return row ? toOfferedWorkspace(row) : undefined;
  }

  async saveCode(code: StoredAuthorizationCode) {
    await this.db.oAuthAuthorizationCode.create({ data: code, select: { id: true } });
  }

  /** One transaction. The same answer sent twice can race to create the consent: the loser
   * updates the row the winner created, so neither sees a unique violation. */
  async saveApproval(consent: ConsentGrant, code: StoredAuthorizationCode) {
    const save = () =>
      this.db.$transaction(async (tx) => {
        const { userId, appId, workspaceId, scopes } = consent;
        await tx.userAppConsent.upsert({
          where: { userId_appId_workspaceId: { userId, appId, workspaceId } },
          create: consent,
          update: { scopes, revokedAt: null },
          select: { id: true },
        });
        await tx.oAuthAuthorizationCode.create({ data: code, select: { id: true } });
      });
    try {
      await save();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await save();
    }
  }
}

/** Workspaces where `userId` is a member and the app is installed. */
const offered = (appId: string, userId: string) => ({
  members: { some: { userId } },
  appInstallations: { some: { appId } },
});

const workspaceWithConsent = (appId: string, userId: string) =>
  ({
    id: true,
    slug: true,
    name: true,
    appConsents: { where: { appId, userId, revokedAt: null }, select: { scopes: true } },
  }) as const;

function toOfferedWorkspace(row: {
  id: string;
  slug: string;
  name: string;
  appConsents: { scopes: string[] }[];
}): OfferedWorkspace {
  const [consent] = row.appConsents;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    ...(consent ? { consentScopes: consent.scopes } : {}),
  };
}
