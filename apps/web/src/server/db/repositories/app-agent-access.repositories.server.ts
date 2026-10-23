import { APP_GRANT_AGENT_CARD_KIND } from "@lrm/coforge-sdk/agent";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { grantCovers, type AgentAppGrantSource } from "#src/features/apps/agent-app-access";
import { toAgentAccessMode } from "#src/features/apps/agent-access-scope";
import { APP_SCOPES } from "#src/features/apps/app-registration";
import { findWorkspaceMemberRole } from "./workspace-member-role.repositories.server";
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
  agentManifestUrl: true,
  allowedScopes: true,
  ownerWorkspaceId: true,
  logoObjectKey: true,
} as const;

/** What an installation's Agent access scope reads; the app is installed once per Workspace. */
export const SCOPE_SELECT = {
  agentAccess: true,
  agents: { where: { agent: ACTIVE_AGENT_WHERE }, select: { agentId: true } },
} as const;

/** An app row's logo, as the one fact about it that leaves the server: its URL. */
const LOGO = { key: true, ownerWorkspaceId: true, logoObjectKey: true } as const;
const logoUrlOf = (app: Prisma.AppGetPayload<{ select: typeof LOGO }>) =>
  appLogoUrl(app.ownerWorkspaceId, app.key, app.logoObjectKey);

const installed = ({
  ownerWorkspaceId,
  logoObjectKey,
  installations,
  ...app
}: Prisma.AppGetPayload<{
  select: typeof INSTALLED_APP & { installations: { select: typeof SCOPE_SELECT } };
}>) => ({
  ...app,
  logoUrl: logoUrlOf({ key: app.key, ownerWorkspaceId, logoObjectKey }),
  agentAccess: toAgentAccessMode(installations[0]?.agentAccess ?? ""),
  selectedAgentIds: installations[0]?.agents.map((row) => row.agentId) ?? [],
});

const PENDING = "pending";

type Tx = Prisma.TransactionClient;
type GrantInput = Parameters<AppAgentAccessStore["giveGrant"]>[0];

/** Approves the Agent's request while it is still pending, and settles its approval card as
 * executed by `userId` (null for none); `false` when it is no longer pending. The one step every
 * approval shares, so a decided request never leaves its card waiting. */
export async function approvePendingRequest(
  tx: Tx,
  input: { requestId: string; agentId: string; userId: string | null },
) {
  const { count } = await tx.appAgentAccessRequest.updateMany({
    where: { id: input.requestId, agentId: input.agentId, status: PENDING },
    data: { status: "approved", decidedAt: new Date(), decidedByUserId: input.userId },
  });
  if (count !== 1) return false;
  await settleAppGrantCard(tx, input.requestId, { approved: true, userId: input.userId });
  return true;
}

/** Ends the Agents' access to an app in the Workspaces `workspace` names: revokes their grants
 * (the rows stay, so a reinstall needs a person's approval again) and denies their pending
 * requests. Part of what removing an installation revokes (`removeAppInstallations`). */
export async function revokeAppAgentAccess(
  tx: Tx,
  input: { appId: string; workspace: string | { not: string }; userId: string; at: Date },
) {
  const scope = { appId: input.appId, workspaceId: input.workspace };
  await tx.appAgentGrant.updateMany({
    where: { ...scope, revokedAt: null },
    data: { revokedAt: input.at, revokedByUserId: input.userId },
  });
  await tx.appAgentAccessRequest.updateMany({
    where: { ...scope, status: PENDING },
    data: { status: "denied", decidedAt: input.at, decidedByUserId: input.userId },
  });
}

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

  findMemberRole(workspaceId: string, userId: string) {
    return findWorkspaceMemberRole(this.db, workspaceId, userId);
  }

  async findAgent(workspaceId: string, agentId: string) {
    const row = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: {
        ownerId: true,
        visibility: true,
        systemKind: true,
        workspace: { select: { slug: true } },
      },
    });
    return row
      ? {
          ownerId: row.ownerId,
          visibility: row.visibility,
          systemKind: row.systemKind,
          workspaceSlug: row.workspace.slug,
        }
      : undefined;
  }

  async listInstalledApps(workspaceId: string) {
    const rows = await this.db.app.findMany({
      where: { installations: { some: { workspaceId } } },
      select: {
        ...INSTALLED_APP,
        installations: { where: { workspaceId }, select: SCOPE_SELECT },
      },
      orderBy: [{ name: "asc" }, { key: "asc" }],
    });
    return rows.map(installed);
  }

  async findInstalledApp(workspaceId: string, appKey: string) {
    const row = await this.db.app.findFirst({
      where: { key: appKey, installations: { some: { workspaceId } } },
      select: {
        ...INSTALLED_APP,
        installations: { where: { workspaceId }, select: SCOPE_SELECT },
      },
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
        app: {
          select: {
            ...LOGO,
            name: true,
            description: true,
            homepageUrl: true,
            agentManifestUrl: true,
          },
        },
      },
      orderBy: [{ app: { name: "asc" } }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      appKey: row.app.key,
      appName: row.app.name,
      appDescription: row.app.description,
      homepageUrl: row.app.homepageUrl,
      agentManifestUrl: row.app.agentManifestUrl,
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
      const approved = await approvePendingRequest(tx, {
        requestId: pending.id,
        agentId: grant.agentId,
        userId: grant.grantedByUserId,
      });
      return approved ? pending.id : undefined;
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

  extendRequest(input: { requestId: string; scopes: string[] }) {
    return this.db.$transaction(async (tx) => {
      // The row lock makes concurrent extensions take turns, so none drops another's scope.
      const [row] = await tx.$queryRaw<{ scopes: string[] }[]>`
        SELECT "scopes" FROM "app_agent_access_requests"
        WHERE "id" = ${input.requestId}::uuid AND "status" = 'pending' FOR UPDATE`;
      if (!row) return undefined;
      const wanted = new Set([...row.scopes, ...input.scopes]);
      const scopes = APP_SCOPES.filter((scope) => wanted.has(scope));
      await tx.appAgentAccessRequest.update({ where: { id: input.requestId }, data: { scopes } });
      // The approval card shows what the request asks for.
      const card = await tx.actionCard.findFirst({
        where: {
          kind: APP_GRANT_AGENT_CARD_KIND,
          state: "pending",
          payload: { path: ["requestId"], equals: input.requestId },
        },
        select: { messageId: true, payload: true },
      });
      if (card && typeof card.payload === "object" && card.payload !== null)
        await tx.actionCard.update({
          where: { messageId: card.messageId },
          data: { payload: { ...card.payload, scopes } },
        });
      return scopes;
    });
  }

  approveRequest(input: { requestId: string; userId: string; grant: GrantInput }) {
    return this.db.$transaction(async (tx) => {
      const { grant } = input;
      const approved = await approvePendingRequest(tx, {
        requestId: input.requestId,
        agentId: grant.agentId,
        userId: input.userId,
      });
      if (!approved) return false;
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
