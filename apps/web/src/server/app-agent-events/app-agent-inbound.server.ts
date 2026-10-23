import { AppError } from "#src/lib/app-error";
import type { WorkspaceMemberRole } from "#src/features/workspaces/workspace-roles";
import {
  agentInScope,
  canManageAgentAppAccess,
} from "#src/server/app-agent-access/access-rules.server";
import type { AgentScope } from "#src/server/app-agent-access/access-rules.server";
import { inboundRequestExpired } from "./inbound-rules.server";
import { canSeeAgent } from "#src/server/agents/agent-visibility.server";
import { autoApprovalApplies, decideInboundAccess, inboundScopesOf } from "./inbound-rules.server";

/** What an app names to send to: a Workspace by slug and an Agent by id (which wins) or name. */
export type InboundTarget = {
  workspaceSlug: string;
  agentId?: string;
  agentName?: string;
};

/** The facts about an app's request to one Agent: the installed app, the live Agent, and what the
 * app already holds for it. */
export type InboundFacts = {
  app: {
    id: string;
    key: string;
    name: string;
    allowedScopes: string[];
    ownerWorkspaceId: string;
    createdByUserId: string | null;
  };
  workspace: { id: string; slug: string };
  agent: { id: string; name: string; displayName: string; ownerId: string };
  installation: AgentScope;
  /** The app creator's role in the Agent's Workspace; `undefined` for a non-member or no creator. */
  creatorRole: WorkspaceMemberRole | undefined;
  grant: { scopes: string[]; revoked: boolean; source: string } | undefined;
  pendingRequest: { id: string; scopes: string[] } | undefined;
};

/** A request as an app reads it back. */
export type InboundRequestView = {
  id: string;
  status: "pending" | "approved" | "denied" | "exchanged" | "expired";
  scopes: string[];
  agent: {
    id: string;
    name: string;
    displayName: string;
    workspaceId: string;
    workspaceSlug: string;
  };
};

/** A request as the store holds it. */
export type StoredInboundRequest = {
  id: string;
  appId: string;
  status: string;
  exchangedAt: Date | null;
  createdAt: Date;
  scopes: string[];
  agent: { id: string; name: string; displayName: string };
  workspace: { id: string; slug: string };
};

/** The Agent's page: what apps may send to it, and what waits for a person. */
export type AgentInboundList = {
  /** `app-agent-events` is on in the Workspace; where it is not, the page shows nothing. */
  enabled: boolean;
  canManage: boolean;
  grants: {
    id: string;
    appKey: string;
    appName: string;
    appLogoUrl: string | null;
    scopes: string[];
    source: "automatic" | "approval";
    grantedAt: Date;
  }[];
  pendingRequests: {
    id: string;
    appKey: string;
    appName: string;
    appLogoUrl: string | null;
    scopes: string[];
    createdAt: Date;
  }[];
  /** The newest events apps sent to the Agent, newest first. */
  events: AgentEventView[];
};

/** An event an app sent, as the Agent's page lists it. */
export type AgentEventView = {
  id: string;
  appKey: string;
  appName: string;
  appLogoUrl: string | null;
  kind: "event" | "notification";
  summary: string;
  payload: unknown;
  payloadHash: string;
  createdAt: Date;
  expiresAt: Date;
  /** Past `expiresAt`: the Agent is no longer told of it; the Message stays in history. */
  expired: boolean;
};

export type InboundActor = { workspaceId: string; userId: string };

export interface AppAgentInboundStore {
  /** The facts for `target`; `undefined` when the Workspace, the Agent or the app's installation
   * there does not exist. */
  findFacts(appId: string, target: InboundTarget): Promise<InboundFacts | undefined>;
  /** Stores an approved request, and `grant` (created, or widened to `grant.scopes`) in the same
   * transaction; the request's id. */
  createApproved(input: {
    appId: string;
    agentId: string;
    workspaceId: string;
    scopes: string[];
    grant?: { scopes: string[] };
  }): Promise<string>;
  /** A pending request for the app and Agent, widened to `scopes`; its id. One racing another
   * returns the winner's. */
  upsertPending(input: {
    appId: string;
    agentId: string;
    workspaceId: string;
    scopes: string[];
  }): Promise<string>;
  findRequest(requestId: string): Promise<StoredInboundRequest | undefined>;
  findMemberRole(workspaceId: string, userId: string): Promise<WorkspaceMemberRole | undefined>;
  findAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<
    | { ownerId: string; visibility: string; systemKind: string | null; workspaceSlug: string }
    | undefined
  >;
  list(agentId: string): Promise<Omit<AgentInboundList, "canManage" | "enabled">>;
  /** Approves the pending request of the Agent and gives the grant, atomically; `false` when it is
   * no longer pending. */
  approve(input: { requestId: string; agentId: string; userId: string }): Promise<boolean>;
  deny(input: { requestId: string; agentId: string; userId: string }): Promise<boolean>;
  /** `false` when the Agent has no active grant `grantId`. */
  revoke(input: { grantId: string; agentId: string; userId: string }): Promise<boolean>;
}

/**
 * An installed app's access to send events and notifications to one Agent (Agent inbound). The app
 * asks with its client credentials (`request`), and the request is approved at once by the
 * automatic rule or an active grant, or waits for a person who may manage the Agent's app access
 * (`approve`, `deny`); a person's `revoke` of the grant stops the app until a person approves
 * again. The Agent, the Workspace and the installation are checked on every use.
 */
export class AppAgentInbound {
  constructor(
    private readonly store: AppAgentInboundStore,
    /** Whether `app-agent-events` is on for the Workspace; where it is off the feature does not exist. */
    private readonly enabled: (workspace: {
      workspaceId: string;
      workspaceSlug: string;
    }) => Promise<boolean> = async () => true,
  ) {}

  isEnabled(workspace: { workspaceId: string; workspaceSlug: string }) {
    return this.enabled(workspace);
  }

  /** The app `appId` asks to send to the Agent `target` names, with `scopes`. `undefined`: no such
   * Workspace, Agent or installation, or the feature is off there (answered alike, so an app learns
   * nothing about the others). */
  async request(
    appId: string,
    target: InboundTarget,
    scopes: string[],
  ): Promise<InboundRequestView | undefined> {
    const facts = await this.store.findFacts(appId, target);
    if (!facts) return undefined;
    if (
      !(await this.enabled({
        workspaceId: facts.workspace.id,
        workspaceSlug: facts.workspace.slug,
      }))
    )
      return undefined;
    const inScope = agentInScope(facts.installation, facts.agent.id);
    const automatic = autoApprovalApplies({
      local: facts.app.ownerWorkspaceId === facts.workspace.id,
      inScope,
      creator: facts.app.createdByUserId
        ? { userId: facts.app.createdByUserId, role: facts.creatorRole }
        : undefined,
      agent: facts.agent,
    });
    const decision = decideInboundAccess({
      declared: facts.app.allowedScopes,
      requested: scopes,
      grant: facts.grant,
      inScope,
      automatic,
      pendingRequest: facts.pendingRequest,
    });
    const scope = { appId, agentId: facts.agent.id, workspaceId: facts.workspace.id };
    const id =
      decision.kind === "approved"
        ? await this.store.createApproved({
            ...scope,
            scopes: decision.scopes,
            ...(decision.created ? { grant: { scopes: decision.scopes } } : {}),
          })
        : await this.store.upsertPending({ ...scope, scopes: decision.scopes });
    return {
      id,
      status: decision.kind,
      scopes: decision.scopes,
      agent: {
        ...facts.agent,
        workspaceId: facts.workspace.id,
        workspaceSlug: facts.workspace.slug,
      },
    };
  }

  /** The app's own request `requestId`; `undefined` for another app's or an unknown one. */
  async status(appId: string, requestId: string): Promise<InboundRequestView | undefined> {
    const stored = await this.store.findRequest(requestId);
    if (!stored || stored.appId !== appId) return undefined;
    return viewOf(stored, new Date());
  }

  /** What the Agent's page shows. Everyone who can see the Agent reads it; `canManage` says who may
   * change it. */
  async list(actor: InboundActor, agentId: string): Promise<AgentInboundList> {
    const { canManage, workspaceSlug } = await this.viewAgent(actor, agentId);
    const enabled = await this.enabled({ workspaceId: actor.workspaceId, workspaceSlug });
    if (!enabled) return { enabled, canManage, grants: [], pendingRequests: [], events: [] };
    const list = await this.store.list(agentId);
    // The payload is app-controlled content: only those who may approve the app's access read it.
    return {
      enabled,
      canManage,
      ...list,
      events: canManage ? list.events : list.events.map((event) => ({ ...event, payload: null })),
    };
  }

  async approve(actor: InboundActor, input: { agentId: string; requestId: string }) {
    await this.manage(actor, input.agentId);
    if (!(await this.store.approve({ ...input, userId: actor.userId })))
      throw new AppError("CONFLICT");
  }

  async deny(actor: InboundActor, input: { agentId: string; requestId: string }) {
    await this.manage(actor, input.agentId);
    if (!(await this.store.deny({ ...input, userId: actor.userId })))
      throw new AppError("CONFLICT");
  }

  /** Revokes the grant at once: the app's tokens for the Agent stop working, and the app needs a
   * person's approval to send again. */
  async revoke(actor: InboundActor, input: { agentId: string; grantId: string }) {
    await this.manage(actor, input.agentId);
    if (!(await this.store.revoke({ ...input, userId: actor.userId })))
      throw new AppError("NOT_FOUND");
  }

  private async manage(actor: InboundActor, agentId: string) {
    if (!(await this.viewAgent(actor, agentId)).canManage) throw new AppError("ACCESS_DENIED");
  }

  private async viewAgent(actor: InboundActor, agentId: string) {
    const [role, agent] = await Promise.all([
      this.store.findMemberRole(actor.workspaceId, actor.userId),
      this.store.findAgent(actor.workspaceId, agentId),
    ]);
    if (!role) throw new AppError("ACCESS_DENIED");
    if (!agent || !canSeeAgent({ kind: "user", userId: actor.userId, role }, agent))
      throw new AppError("NOT_FOUND");
    return {
      canManage: canManageAgentAppAccess({ userId: actor.userId, role }, agent),
      workspaceSlug: agent.workspaceSlug,
    };
  }
}

/** A stored request as an app reads it: an approved one already exchanged is `exchanged`. */
export function viewOf(stored: StoredInboundRequest, now: Date): InboundRequestView {
  const status =
    !stored.exchangedAt &&
    inboundRequestExpired(stored.createdAt, now) &&
    stored.status !== "denied"
      ? "expired"
      : stored.status === "approved" && stored.exchangedAt
        ? "exchanged"
        : (stored.status as "pending" | "approved" | "denied");
  return {
    id: stored.id,
    status,
    scopes: inboundScopesOf(stored.scopes),
    agent: {
      ...stored.agent,
      workspaceId: stored.workspace.id,
      workspaceSlug: stored.workspace.slug,
    },
  };
}
