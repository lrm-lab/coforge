import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { toAgentAccessMode } from "#src/features/apps/agent-access-scope";
import { APP_AGENT_INBOUND_SCOPES } from "#src/features/apps/app-registration";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type {
  AppAgentInboundStore,
  InboundTarget,
} from "#src/server/app-agent-events/app-agent-inbound.server";
import { agentInScope } from "#src/server/app-agent-access/access-rules.server";
import {
  INBOUND_REQUEST_TTL_MS,
  effectiveInboundAccess,
} from "#src/server/app-agent-events/inbound-rules.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { appLogoUrl } from "#src/server/apps/app-logo.server";
import { findWorkspaceMemberRole } from "./workspace-member-role.repositories.server";

const PENDING = "pending";
/** How many of an Agent's newest events its page lists. */
const RECENT_EVENTS = 30;
const LOGO = { key: true, ownerWorkspaceId: true, logoObjectKey: true } as const;
type Tx = Prisma.TransactionClient;

/** Requests created at or before this are expired. */
const staleBefore = () => new Date(Date.now() - INBOUND_REQUEST_TTL_MS);

const inbound = (scopes: readonly string[]) =>
  APP_AGENT_INBOUND_SCOPES.filter((scope) => scopes.includes(scope));

/** Gives the app its grant for the Agent, created or widened to `scopes` (never narrowed), active. */
async function giveGrant(
  tx: Tx,
  input: { appId: string; agentId: string; workspaceId: string; scopes: string[] },
  by: { source: "automatic" | "approval"; userId: string | null },
) {
  const key = { appId_agentId: { appId: input.appId, agentId: input.agentId } };
  const held = await tx.appAgentInboundGrant.findUnique({ where: key });
  const scopes = inbound([...(held && !held.revokedAt ? held.scopes : []), ...input.scopes]);
  const given = {
    scopes,
    // An automatic widening never turns a person's approval into an automatic grant.
    source: held && !held.revokedAt && held.source === "approval" ? "approval" : by.source,
    grantedByUserId: by.userId,
    revokedAt: null,
    revokedByUserId: null,
  };
  await tx.appAgentInboundGrant.upsert({
    where: key,
    create: {
      appId: input.appId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      ...given,
    },
    update: given,
  });
}

/** Ends the apps' sending to the Agents of the Workspaces `workspace` names: revokes their grants
 * (the rows stay, so a reinstall needs a person's approval again) and denies their pending
 * requests. Part of what removing an installation revokes (`removeAppInstallations`). */
export async function revokeAppAgentInbound(
  tx: Tx,
  input: { appId: string; workspace: string | { not: string }; userId: string; at: Date },
) {
  const scope = { appId: input.appId, workspaceId: input.workspace };
  await tx.appAgentInboundGrant.updateMany({
    where: { ...scope, revokedAt: null },
    data: { revokedAt: input.at, revokedByUserId: input.userId },
  });
  await tx.appAgentInboundRequest.updateMany({
    where: { ...scope, status: PENDING },
    data: { status: "denied", decidedAt: input.at, decidedByUserId: input.userId },
  });
}

/** An installation's Agent selection narrowed: revokes the grants of the Agents it no longer
 * includes and denies their pending requests, so the app needs a person's approval again. */
export async function revokeExcludedAgentInbound(
  tx: Tx,
  input: { appId: string; workspaceId: string; keepAgentIds: string[]; userId: string },
) {
  const excluded = {
    appId: input.appId,
    workspaceId: input.workspaceId,
    agentId: { notIn: input.keepAgentIds },
  };
  const at = new Date();
  await tx.appAgentInboundGrant.updateMany({
    where: { ...excluded, revokedAt: null },
    data: { revokedAt: at, revokedByUserId: input.userId },
  });
  await tx.appAgentInboundRequest.updateMany({
    where: { ...excluded, status: PENDING },
    data: { status: "denied", decidedAt: at, decidedByUserId: input.userId },
  });
}

/** Agent inbound rows; when an app may send, and who may decide, stay in
 * `server/app-agent-events/`. */
export class PrismaAppAgentInboundStore implements AppAgentInboundStore {
  constructor(private readonly db: PrismaClient) {}

  async findFacts(appId: string, target: InboundTarget) {
    const workspace = await this.db.workspace.findUnique({
      where: { slug: target.workspaceSlug },
      select: { id: true, slug: true },
    });
    if (!workspace) return undefined;
    const agent = await this.db.agent.findFirst({
      where: {
        workspaceId: workspace.id,
        ...ACTIVE_AGENT_WHERE,
        systemKind: null,
        ...(target.agentId ? { id: target.agentId } : { name: target.agentName ?? "" }),
      },
      select: { id: true, name: true, displayName: true, ownerId: true },
    });
    if (!agent) return undefined;
    const [app, installation, grant, pending] = await Promise.all([
      this.db.app.findUnique({
        where: { id: appId },
        select: {
          id: true,
          key: true,
          name: true,
          allowedScopes: true,
          ownerWorkspaceId: true,
          createdByUserId: true,
        },
      }),
      this.db.appInstallation.findUnique({
        where: { appId_workspaceId: { appId, workspaceId: workspace.id } },
        select: { agentAccess: true, agents: { select: { agentId: true } } },
      }),
      this.db.appAgentInboundGrant.findUnique({
        where: { appId_agentId: { appId, agentId: agent.id } },
        select: { scopes: true, revokedAt: true, source: true },
      }),
      this.db.appAgentInboundRequest.findFirst({
        where: { appId, agentId: agent.id, status: PENDING, createdAt: { gt: staleBefore() } },
        select: { id: true, scopes: true },
      }),
    ]);
    if (!app || !installation) return undefined;
    return {
      app,
      workspace,
      agent,
      installation: {
        agentAccess: toAgentAccessMode(installation.agentAccess),
        selectedAgentIds: installation.agents.map((row) => row.agentId),
      },
      creatorRole: app.createdByUserId
        ? await findWorkspaceMemberRole(this.db, workspace.id, app.createdByUserId)
        : undefined,
      grant: grant
        ? { scopes: grant.scopes, revoked: grant.revokedAt !== null, source: grant.source }
        : undefined,
      pendingRequest: pending ?? undefined,
    };
  }

  async createApproved(input: {
    appId: string;
    agentId: string;
    workspaceId: string;
    scopes: string[];
    grant?: { scopes: string[] };
  }) {
    const { grant, ...request } = input;
    return this.db.$transaction(async (tx) => {
      if (grant)
        await giveGrant(
          tx,
          { ...request, scopes: grant.scopes },
          { source: "automatic", userId: null },
        );
      const created = await tx.appAgentInboundRequest.create({
        data: { ...request, status: "approved", decidedAt: new Date() },
        select: { id: true },
      });
      return created.id;
    });
  }

  async upsertPending(input: {
    appId: string;
    agentId: string;
    workspaceId: string;
    scopes: string[];
  }) {
    // A request nobody decided within its day is over; the app's new one replaces it.
    await this.db.appAgentInboundRequest.updateMany({
      where: {
        appId: input.appId,
        agentId: input.agentId,
        status: PENDING,
        createdAt: { lte: staleBefore() },
      },
      data: { status: "denied", decidedAt: new Date() },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const waiting = await this.db.appAgentInboundRequest.findFirst({
        where: { appId: input.appId, agentId: input.agentId, status: PENDING },
        select: { id: true, scopes: true },
      });
      if (waiting) {
        await this.db.appAgentInboundRequest.updateMany({
          where: { id: waiting.id, status: PENDING },
          data: { scopes: inbound([...waiting.scopes, ...input.scopes]) },
        });
        return waiting.id;
      }
      try {
        const created = await this.db.appAgentInboundRequest.create({
          data: { ...input, status: PENDING },
          select: { id: true },
        });
        return created.id;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("a pending Agent inbound request could not be stored");
  }

  async findRequest(requestId: string) {
    const row = await this.db.appAgentInboundRequest
      .findUnique({
        where: { id: requestId },
        select: {
          id: true,
          appId: true,
          status: true,
          exchangedAt: true,
          createdAt: true,
          scopes: true,
          agent: { select: { id: true, name: true, displayName: true } },
          workspace: { select: { id: true, slug: true } },
        },
      })
      // A malformed id is no request.
      .catch(() => null);
    return row ?? undefined;
  }

  /** Marks the approved request exchanged, once; `false` when it is not approved or was exchanged. */
  async markExchanged(requestId: string, appId: string) {
    const { count } = await this.db.appAgentInboundRequest.updateMany({
      where: { id: requestId, appId, status: "approved", exchangedAt: null },
      data: { exchangedAt: new Date() },
    });
    return count === 1;
  }

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

  async list(agentId: string) {
    const [grants, requests, events, expired] = await Promise.all([
      this.db.appAgentInboundGrant.findMany({
        where: { agentId, revokedAt: null },
        select: {
          id: true,
          scopes: true,
          source: true,
          updatedAt: true,
          app: { select: { ...LOGO, name: true } },
        },
        orderBy: [{ app: { name: "asc" } }, { id: "asc" }],
      }),
      this.db.appAgentInboundRequest.findMany({
        where: { agentId, status: PENDING, createdAt: { gt: staleBefore() } },
        select: {
          id: true,
          scopes: true,
          createdAt: true,
          app: { select: { ...LOGO, name: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      this.db.appAgentEvent.findMany({
        where: { agentId },
        select: {
          id: true,
          kind: true,
          summary: true,
          payload: true,
          payloadHash: true,
          createdAt: true,
          expiresAt: true,
          app: { select: { ...LOGO, name: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: RECENT_EVENTS,
      }),
      // On the database clock, the one an event's delivery expires by.
      this.db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "app_agent_events"
        WHERE "agentId" = ${agentId}::uuid AND "expiresAt" <= (now() AT TIME ZONE 'UTC')`,
    ]);
    const expiredIds = new Set(expired.map((row) => row.id));
    const logo = (app: Prisma.AppGetPayload<{ select: typeof LOGO }>) =>
      appLogoUrl(app.ownerWorkspaceId, app.key, app.logoObjectKey);
    return {
      grants: grants.map((row) => ({
        id: row.id,
        appKey: row.app.key,
        appName: row.app.name,
        appLogoUrl: logo(row.app),
        scopes: row.scopes,
        // `app_agent_inbound_grants_source_check` admits only the two sources.
        source: row.source as "automatic" | "approval",
        grantedAt: row.updatedAt,
      })),
      pendingRequests: requests.map((row) => ({
        id: row.id,
        appKey: row.app.key,
        appName: row.app.name,
        appLogoUrl: logo(row.app),
        scopes: row.scopes,
        createdAt: row.createdAt,
      })),
      events: events.map((row) => ({
        id: row.id,
        appKey: row.app.key,
        appName: row.app.name,
        appLogoUrl: logo(row.app),
        // `app_agent_events_kind_check` admits only the two kinds.
        kind: row.kind as "event" | "notification",
        summary: row.summary,
        payload: row.payload,
        payloadHash: row.payloadHash,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        expired: expiredIds.has(row.id),
      })),
    };
  }

  approve(input: { requestId: string; agentId: string; userId: string }) {
    return this.db.$transaction(async (tx) => {
      const request = await tx.appAgentInboundRequest.findFirst({
        where: {
          id: input.requestId,
          agentId: input.agentId,
          status: PENDING,
          createdAt: { gt: staleBefore() },
        },
        select: { appId: true, workspaceId: true, scopes: true },
      });
      if (!request) return false;
      const { count } = await tx.appAgentInboundRequest.updateMany({
        where: { id: input.requestId, status: PENDING },
        data: { status: "approved", decidedAt: new Date(), decidedByUserId: input.userId },
      });
      if (count !== 1) return false;
      await giveGrant(
        tx,
        { ...request, agentId: input.agentId },
        { source: "approval", userId: input.userId },
      );
      return true;
    });
  }

  async deny(input: { requestId: string; agentId: string; userId: string }) {
    const { count } = await this.db.appAgentInboundRequest.updateMany({
      where: { id: input.requestId, agentId: input.agentId, status: PENDING },
      data: { status: "denied", decidedAt: new Date(), decidedByUserId: input.userId },
    });
    return count === 1;
  }

  async revoke(input: { grantId: string; agentId: string; userId: string }) {
    const { count } = await this.db.appAgentInboundGrant.updateMany({
      where: { id: input.grantId, agentId: input.agentId, revokedAt: null },
      data: { revokedAt: new Date(), revokedByUserId: input.userId },
    });
    return count === 1;
  }

  /** What a token's use checks, in one read from the grant: the app by key, its installation in the
   * Workspace, the live Agent and the Workspace's slug, and what the app may send now
   * (`effectiveInboundAccess`). `undefined` when the app has no grant for the Agent, or the
   * installation, the Agent or the app is gone. */
  async findTokenFacts(input: { appKey: string; workspaceId: string; agentId: string }) {
    const row = await this.db.appAgentInboundGrant.findFirst({
      where: {
        workspaceId: input.workspaceId,
        agent: { id: input.agentId, workspaceId: input.workspaceId, ...ACTIVE_AGENT_WHERE },
        app: { key: input.appKey, installations: { some: { workspaceId: input.workspaceId } } },
      },
      select: {
        scopes: true,
        revokedAt: true,
        source: true,
        agent: { select: { workspace: { select: { slug: true } } } },
        app: {
          select: {
            id: true,
            key: true,
            name: true,
            allowedScopes: true,
            installations: {
              where: { workspaceId: input.workspaceId },
              select: { agentAccess: true, agents: { select: { agentId: true } } },
            },
          },
        },
      },
    });
    const installation = row?.app.installations[0];
    if (!row || !installation) return undefined;
    const { installations: _installations, ...app } = row.app;
    const access = effectiveInboundAccess({
      declared: app.allowedScopes,
      grant: { scopes: row.scopes, revoked: row.revokedAt !== null, source: row.source },
      inScope: agentInScope(
        {
          agentAccess: toAgentAccessMode(installation.agentAccess),
          selectedAgentIds: installation.agents.map((agent) => agent.agentId),
        },
        input.agentId,
      ),
    });
    return { app, workspaceSlug: row.agent.workspace.slug, ...access };
  }
}
