import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { grantCovers, type AgentAppGrantSource } from "#src/features/apps/agent-app-access";
import { APP_SCOPES } from "#src/features/apps/app-registration";
import { isWorkspaceMemberRole } from "#src/server/workspaces/member-role.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type { AppAgentAccessStore } from "#src/server/app-agent-access/app-agent-access.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { settleAppGrantCard } from "#src/server/conversations/app-grant-cards.server";
import { appLogoUrl } from "#src/server/apps/app-logo.server";

const INSTALLED_APP = {
  id: true,
  key: true,
  name: true,
  description: true,
  whenToUse: true,
  homepageUrl: true,
  allowedScopes: true,
  ownerWorkspaceId: true,
  logoObjectKey: true,
} as const;

/** An app row's logo, as the one fact about it that leaves the server: its URL. */
const LOGO = { key: true, ownerWorkspaceId: true, logoObjectKey: true } as const;
const logoUrlOf = (app: Prisma.AppGetPayload<{ select: typeof LOGO }>) =>
  appLogoUrl(app.ownerWorkspaceId, app.key, app.logoObjectKey);

const installed = ({
  ownerWorkspaceId,
  logoObjectKey,
  ...app
}: Prisma.AppGetPayload<{ select: typeof INSTALLED_APP }>) => ({
  ...app,
  logoUrl: logoUrlOf({ key: app.key, ownerWorkspaceId, logoObjectKey }),
});

const PENDING = "pending";

type Tx = Prisma.TransactionClient;
type GrantInput = Parameters<AppAgentAccessStore["giveGrant"]>[0];

/** Gives `grant`: creates the Agent's row for the app, or replaces the one it had. */
function upsertGrant(tx: Tx, grant: GrantInput) {
  const given = {
    scopes: grant.scopes,
    source: grant.source,
    grantedByUserId: grant.grantedByUserId,
    revokedAt: null,
    revokedByUserId: null,
  };
  return tx.appAgentGrant.upsert({
    where: { appId_agentId: { appId: grant.appId, agentId: grant.agentId } },
    create: {
      appId: grant.appId,
      agentId: grant.agentId,
      workspaceId: grant.workspaceId,
      ...given,
    },
    update: given,
  });
}

/** App access rows; who may change an Agent's access, and when an Agent may use an app, stay in
 * `server/app-agent-access/`. */
export class PrismaAppAgentAccessStore implements AppAgentAccessStore {
  constructor(private readonly db: PrismaClient) {}

  async findMemberRole(workspaceId: string, userId: string) {
    const row = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return row && isWorkspaceMemberRole(row.role) ? row.role : undefined;
  }

  async findAgent(workspaceId: string, agentId: string) {
    const row = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { ownerId: true, visibility: true, systemKind: true },
    });
    return row ?? undefined;
  }

  async listInstalledApps(workspaceId: string) {
    const rows = await this.db.app.findMany({
      where: { installations: { some: { workspaceId } } },
      select: INSTALLED_APP,
      orderBy: [{ name: "asc" }, { key: "asc" }],
    });
    return rows.map(installed);
  }

  async findInstalledApp(workspaceId: string, appKey: string) {
    const row = await this.db.app.findFirst({
      where: { key: appKey, installations: { some: { workspaceId } } },
      select: INSTALLED_APP,
    });
    return row ? installed(row) : undefined;
  }

  async listActiveGrants(agentId: string) {
    const rows = await this.db.appAgentGrant.findMany({
      where: { agentId, revokedAt: null },
      select: {
        id: true,
        scopes: true,
        source: true,
        updatedAt: true,
        app: { select: { ...LOGO, name: true, description: true, homepageUrl: true } },
      },
      orderBy: [{ app: { name: "asc" } }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      appKey: row.app.key,
      appName: row.app.name,
      appDescription: row.app.description,
      homepageUrl: row.app.homepageUrl,
      appLogoUrl: logoUrlOf(row.app),
      scopes: row.scopes,
      // `app_agent_grants_source_check` admits only the three sources.
      source: row.source as AgentAppGrantSource,
      grantedAt: row.updatedAt,
    }));
  }

  async listPendingRequests(agentId: string) {
    const rows = await this.db.appAgentAccessRequest.findMany({
      where: { agentId, status: PENDING },
      select: {
        id: true,
        scopes: true,
        createdAt: true,
        app: { select: { ...LOGO, name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      appKey: row.app.key,
      appName: row.app.name,
      appLogoUrl: logoUrlOf(row.app),
      scopes: row.scopes,
      createdAt: row.createdAt,
    }));
  }

  async listGrantStates(agentId: string) {
    const rows = await this.db.appAgentGrant.findMany({
      where: { agentId },
      select: { appId: true, scopes: true, revokedAt: true },
    });
    return rows.map((row) => ({
      appId: row.appId,
      scopes: row.scopes,
      revoked: row.revokedAt !== null,
    }));
  }

  async findGrant(appId: string, agentId: string) {
    const row = await this.db.appAgentGrant.findUnique({
      where: { appId_agentId: { appId, agentId } },
      select: { scopes: true, revokedAt: true },
    });
    return row ? { scopes: row.scopes, revoked: row.revokedAt !== null } : undefined;
  }

  async findPendingRequest(appId: string, agentId: string) {
    const row = await this.db.appAgentAccessRequest.findFirst({
      where: { appId, agentId, status: PENDING },
      select: { id: true, scopes: true },
    });
    return row ?? undefined;
  }

  async findRequest(agentId: string, requestId: string) {
    const row = await this.db.appAgentAccessRequest.findFirst({
      where: { id: requestId, agentId },
      select: { scopes: true, status: true, app: { select: { key: true } } },
    });
    return row
      ? { appKey: row.app.key, scopes: row.scopes, pending: row.status === PENDING }
      : undefined;
  }

  giveGrant(grant: GrantInput) {
    return this.db.$transaction(async (tx) => {
      await upsertGrant(tx, grant);
      const pending = await tx.appAgentAccessRequest.findFirst({
        where: { appId: grant.appId, agentId: grant.agentId, status: PENDING },
        select: { id: true, scopes: true },
      });
      if (!pending || !grantCovers(grant.scopes, pending.scopes)) return undefined;
      const { count } = await tx.appAgentAccessRequest.updateMany({
        where: { id: pending.id, status: PENDING },
        data: { status: "approved", decidedAt: new Date(), decidedByUserId: grant.grantedByUserId },
      });
      if (count !== 1) return undefined;
      await settleAppGrantCard(tx, pending.id, { approved: true, userId: grant.grantedByUserId });
      return pending.id;
    });
  }

  async createAutomaticGrant(grant: GrantInput) {
    try {
      await this.db.appAgentGrant.create({
        data: {
          appId: grant.appId,
          agentId: grant.agentId,
          workspaceId: grant.workspaceId,
          scopes: grant.scopes,
          source: grant.source,
          grantedByUserId: grant.grantedByUserId,
        },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async revokeGrant(input: { agentId: string; grantId: string; userId: string }) {
    const { count } = await this.db.appAgentGrant.updateMany({
      where: { id: input.grantId, agentId: input.agentId, revokedAt: null },
      data: { revokedAt: new Date(), revokedByUserId: input.userId },
    });
    return count === 1;
  }

  async createRequest(input: {
    appId: string;
    agentId: string;
    workspaceId: string;
    scopes: string[];
  }) {
    try {
      const row = await this.db.appAgentAccessRequest.create({
        data: { ...input, status: PENDING },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  approveRequest(input: { requestId: string; userId: string; grant: GrantInput }) {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.appAgentAccessRequest.updateMany({
        where: { id: input.requestId, agentId: input.grant.agentId, status: PENDING },
        data: { status: "approved", decidedAt: new Date(), decidedByUserId: input.userId },
      });
      if (count !== 1) return false;
      await settleAppGrantCard(tx, input.requestId, { approved: true, userId: input.userId });
      const { grant } = input;
      const active = await tx.appAgentGrant.findFirst({
        where: { appId: grant.appId, agentId: grant.agentId, revokedAt: null },
        select: { scopes: true },
      });
      if (active && grantCovers(active.scopes, grant.scopes)) return true;
      const scopes = active
        ? APP_SCOPES.filter(
            (scope) => active.scopes.includes(scope) || grant.scopes.includes(scope),
          )
        : grant.scopes;
      await upsertGrant(tx, { ...grant, scopes });
      return true;
    });
  }

  denyRequest(input: { agentId: string; requestId: string; userId: string }) {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.appAgentAccessRequest.updateMany({
        where: { id: input.requestId, agentId: input.agentId, status: PENDING },
        data: { status: "denied", decidedAt: new Date(), decidedByUserId: input.userId },
      });
      if (count !== 1) return false;
      await settleAppGrantCard(tx, input.requestId, { approved: false, userId: input.userId });
      return true;
    });
  }
}
