import type { AgentAppAccessState } from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import {
  resolveAgentManifest,
  type AgentManifestLocation,
} from "#src/features/apps/app-agent-manifest";
import {
  agentGrantScopes,
  allowedGrantScopes,
  APP_GRANT_REQUEST_CHANGED,
  grantCovers,
  type AgentAppGrantSource,
} from "#src/features/apps/agent-app-access";
import type { WorkspaceMemberRole } from "#src/features/workspaces/workspace-roles";
import { canSeeAgent } from "#src/server/agents/agent-visibility.server";
import {
  canManageAgentAppAccess,
  agentInScope,
  appsVisibleToAgent,
  decideAgentAccess,
  type AgentAccessDecision,
  type AgentScope,
} from "./access-rules.server";

/** A person acting in the Workspace the request names. */
export type AgentAppAccessActor = { workspaceId: string; userId: string };

/** An app installed in the Workspace, as the Agent's Apps tab lists it. */
export type InstalledAppView = {
  key: string;
  name: string;
  description: string;
  whenToUse: string;
  homepageUrl: string | null;
  /** `appLogoUrl`; none shows the monogram. */
  logoUrl: string | null;
  allowedScopes: string[];
};

/** An Agent's active grant for an app; `grantedAt` is when it was last given. */
export type AgentAppGrantView = {
  id: string;
  appKey: string;
  appName: string;
  appDescription: string;
  homepageUrl: string | null;
  appLogoUrl: string | null;
  scopes: string[];
  source: AgentAppGrantSource;
  grantedAt: Date;
} & Partial<AgentManifestLocation>;

/** A grant as the store reads it: the app's own Agent manifest URL, if it set one, instead of the
 * location an Agent is told (`AppAgentAccess` resolves it where `app-agent-manifest` is on). */
type StoredGrant = Omit<AgentAppGrantView, keyof AgentManifestLocation> & {
  agentManifestUrl: string | null;
};

/** `row` as an Agent sees it: where `app-agent-manifest` is on, with the manifest location resolved
 * from the stored URL and the homepage; otherwise without either field. */
function withManifest<T extends { homepageUrl: string | null; agentManifestUrl: string | null }>(
  enabled: boolean,
  row: T,
): Omit<T, "agentManifestUrl"> & Partial<AgentManifestLocation> {
  const { agentManifestUrl, ...rest } = row;
  return enabled ? { ...rest, ...resolveAgentManifest(row) } : rest;
}

/** An Agent's request for an app that waits for a person. */
export type AgentAppRequestView = {
  id: string;
  appKey: string;
  appName: string;
  appLogoUrl: string | null;
  scopes: string[];
  createdAt: Date;
};

/** What the Agent's Apps tab shows; `canManage` says whether the viewer may change it. */
export type AgentAppAccessList = {
  canManage: boolean;
  apps: InstalledAppView[];
  grants: AgentAppGrantView[];
  pendingRequests: AgentAppRequestView[];
};

/** An installed app as the Agent itself lists it, with its access to the app; a logo is for
 * people, so the Agent's list leaves it out. */
export type AgentInstalledAppView = Omit<InstalledAppView, "allowedScopes" | "logoUrl"> & {
  access: AgentAppAccessState;
} & Partial<AgentManifestLocation>;

/** The answer to an Agent asking to use an app. */
export type AgentAccessOutcome =
  | { status: "not_installed" }
  /** `automatic` when this use gave the grant. */
  | { status: "granted"; scopes: string[]; automatic: boolean }
  /** `appName` names the app to whoever approves. */
  | { status: "pending"; requestId: string; scopes: string[]; appName: string };

type InstalledApp = InstalledAppView & { id: string; agentManifestUrl: string | null } & AgentScope;
type AgentRow = {
  ownerId: string;
  visibility: string;
  systemKind: string | null;
  workspaceSlug: string;
};
/** A grant to give: its row is created, or the one revoked or given before is replaced. */
type GrantInput = {
  appId: string;
  agentId: string;
  workspaceId: string;
  scopes: string[];
  source: AgentAppGrantSource;
  grantedByUserId: string | null;
};

export interface AppAgentAccessStore {
  /** The member's role; `undefined` for a non-member or a stored role that is not a known one. */
  findMemberRole(workspaceId: string, userId: string): Promise<WorkspaceMemberRole | undefined>;
  /** The live Agent in the Workspace. */
  findAgent(workspaceId: string, agentId: string): Promise<AgentRow | undefined>;
  listInstalledApps(workspaceId: string): Promise<InstalledApp[]>;
  findInstalledApp(workspaceId: string, appKey: string): Promise<InstalledApp | undefined>;
  listActiveGrants(agentId: string): Promise<StoredGrant[]>;
  listPendingRequests(agentId: string): Promise<AgentAppRequestView[]>;
  /** Every grant the Agent has, active or revoked. */
  listGrantStates(
    agentId: string,
  ): Promise<{ appId: string; scopes: string[]; revoked: boolean }[]>;
  /** The Agent's grant for the app, active or revoked. */
  findGrant(
    appId: string,
    agentId: string,
  ): Promise<{ scopes: string[]; revoked: boolean } | undefined>;
  findPendingRequest(
    appId: string,
    agentId: string,
  ): Promise<{ id: string; scopes: string[] } | undefined>;
  /** The Agent's request `requestId`, with its app's key and whether it still waits. */
  findRequest(
    agentId: string,
    requestId: string,
  ): Promise<{ appKey: string; scopes: string[]; pending: boolean } | undefined>;
  /** Gives the grant a person chose, and approves, as `grant.grantedByUserId`, the Agent's pending
   * request for the app when the grant covers it: that request's id. A decided request's approval
   * card is settled with it. */
  giveGrant(grant: GrantInput): Promise<string | undefined>;
  /** Creates the grant of an Agent's first use; `false` when the Agent already has a row. */
  createAutomaticGrant(grant: GrantInput): Promise<boolean>;
  /** `false` when the Agent has no active grant `grantId`. */
  revokeGrant(input: { agentId: string; grantId: string; userId: string }): Promise<boolean>;
  /** Creates a pending request; `undefined` when one is already pending for the app. */
  createRequest(input: {
    appId: string;
    agentId: string;
    workspaceId: string;
    scopes: string[];
  }): Promise<string | undefined>;
  /** Approves the pending request and gives `grant`, atomically; an active grant keeps its scopes
   * and gains the request's, never losing one. `false` when the request is no longer pending. */
  approveRequest(input: { requestId: string; userId: string; grant: GrantInput }): Promise<boolean>;
  /** Adds `scopes` to the pending request and its approval card if one was posted, never dropping
   * a scope a concurrent extension added: the request's scopes then; `undefined` when the request
   * is no longer pending. */
  extendRequest(input: { requestId: string; scopes: string[] }): Promise<string[] | undefined>;
  /** `false` when the request is no longer pending. */
  denyRequest(input: { agentId: string; requestId: string; userId: string }): Promise<boolean>;
}

/** What the Agent's next use of an installed app gets, as it lists the app. */
function accessState(decision: AgentAccessDecision): AgentAppAccessState {
  if (decision.kind === "granted") return "granted";
  if (decision.kind === "grant_automatically") return "automatic";
  return decision.kind === "needs_approval" && decision.pendingRequestId
    ? "pending_approval"
    : "needs_approval";
}

/** How many times a use is decided again after another use of the same app won a race. */
const RESOLVE_ATTEMPTS = 3;

/**
 * An Agent's access to the apps installed in its Workspace. Every member who can see the Agent
 * lists it; a Workspace owner or admin, or the Agent's creator, grants, revokes, approves and
 * denies (`canManageAgentAppAccess`). An Agent nobody may see, or another Workspace's, is
 * NOT_FOUND; so is an app not installed in the Agent's Workspace.
 */
export class AppAgentAccess {
  constructor(
    private readonly store: AppAgentAccessStore,
    /** Told once a request is decided or widened, so browsers refresh its approval card. Best effort. */
    private readonly requestDecided: (
      workspaceId: string,
      requestId: string,
    ) => Promise<void> = async () => {},
    /** Whether the Workspace has `app-agent-manifest` on: only then are the Agent manifest
     * locations listed. */
    private readonly manifestEnabled: (workspace: {
      workspaceId: string;
      workspaceSlug: string;
    }) => Promise<boolean> = async () => false,
  ) {}

  async list(actor: AgentAppAccessActor, agentId: string): Promise<AgentAppAccessList> {
    const { canManage, workspaceSlug } = await this.viewAgent(actor, agentId);
    const [apps, grants, pendingRequests, manifest] = await Promise.all([
      this.store.listInstalledApps(actor.workspaceId),
      this.store.listActiveGrants(agentId),
      this.store.listPendingRequests(agentId),
      this.manifestEnabled({ workspaceId: actor.workspaceId, workspaceSlug }),
    ]);
    return {
      canManage,
      apps: apps.map(
        ({
          id: _id,
          agentAccess: _access,
          selectedAgentIds: _selected,
          agentManifestUrl: _manifest,
          ...app
        }) => app,
      ),
      grants: grants.map((grant) => withManifest(manifest, grant)),
      pendingRequests,
    };
  }

  /** The apps installed in the Agent's Workspace that the Agent is told about (`appsVisibleToAgent`:
   * its scope includes it, or it has an active grant), with what its next use of each gets
   * (`decideAgentAccess`, asking for no more than the fixed scopes). */
  async listForAgent(agent: {
    workspaceId: string;
    agentId: string;
  }): Promise<AgentInstalledAppView[]> {
    const found = await this.store.findAgent(agent.workspaceId, agent.agentId);
    if (!found) throw new AppError("NOT_FOUND");
    const [apps, grants, pendingRequests, manifest] = await Promise.all([
      this.store.listInstalledApps(agent.workspaceId),
      this.store.listGrantStates(agent.agentId),
      this.store.listPendingRequests(agent.agentId),
      this.manifestEnabled({ workspaceId: agent.workspaceId, workspaceSlug: found.workspaceSlug }),
    ]);
    return appsVisibleToAgent(apps, grants, agent.agentId).map((installedApp) => {
      const {
        id,
        allowedScopes,
        agentManifestUrl,
        logoUrl: _logo,
        agentAccess: _access,
        selectedAgentIds: _selected,
        ...view
      } = installedApp;
      const decision = decideAgentAccess({
        installed: true,
        allowedScopes,
        requestedScopes: [],
        grant: grants.find((grant) => grant.appId === id),
        inScope: agentInScope(installedApp, agent.agentId),
        pendingRequest: pendingRequests.find((request) => request.appKey === view.key),
      });
      return withManifest(manifest, { ...view, agentManifestUrl, access: accessState(decision) });
    });
  }

  /** Grants the app to the Agent with the fixed scopes and `scopes`, replacing a revoked or
   * earlier grant. */
  async grant(
    actor: AgentAppAccessActor,
    input: { agentId: string; appKey: string; scopes: string[] },
  ): Promise<void> {
    await this.manageAgent(actor, input.agentId);
    const app = await this.installedApp(actor.workspaceId, input.appKey);
    const scopes = agentGrantScopes(input.scopes, app.allowedScopes);
    if (!scopes) throw new AppError("INVALID_INPUT", { errorId: "app-scope-not-allowed" });
    const approved = await this.store.giveGrant({
      appId: app.id,
      agentId: input.agentId,
      workspaceId: actor.workspaceId,
      scopes,
      source: "person",
      grantedByUserId: actor.userId,
    });
    if (approved) await this.decided(actor.workspaceId, approved);
  }

  /** Revokes the grant at once; the Agent then needs an approval for the app again. */
  async revoke(
    actor: AgentAppAccessActor,
    input: { agentId: string; grantId: string },
  ): Promise<void> {
    await this.manageAgent(actor, input.agentId);
    if (!(await this.store.revokeGrant({ ...input, userId: actor.userId })))
      throw new AppError("NOT_FOUND");
  }

  /** Approves the request: the Agent gets a grant of its scopes the app still allows, added to
   * an active grant it may have been given meanwhile. An approval that names the `scopes` it was
   * shown (the approval card) is a CONFLICT once the request asks for others. */
  async approve(
    actor: AgentAppAccessActor,
    input: { agentId: string; requestId: string; scopes?: readonly string[] },
  ): Promise<void> {
    await this.manageAgent(actor, input.agentId);
    const request = await this.pendingRequest(input.agentId, input.requestId);
    if (
      input.scopes &&
      !(grantCovers(input.scopes, request.scopes) && grantCovers(request.scopes, input.scopes))
    )
      throw new AppError("CONFLICT", { errorId: APP_GRANT_REQUEST_CHANGED });
    const app = await this.installedApp(actor.workspaceId, request.appKey);
    const scopes = allowedGrantScopes(request.scopes, app.allowedScopes);
    const approved = await this.store.approveRequest({
      requestId: input.requestId,
      userId: actor.userId,
      grant: {
        appId: app.id,
        agentId: input.agentId,
        workspaceId: actor.workspaceId,
        scopes,
        source: "approval",
        grantedByUserId: actor.userId,
      },
    });
    if (!approved) throw new AppError("CONFLICT");
    await this.decided(actor.workspaceId, input.requestId);
  }

  async deny(
    actor: AgentAppAccessActor,
    input: { agentId: string; requestId: string },
  ): Promise<void> {
    await this.manageAgent(actor, input.agentId);
    await this.pendingRequest(input.agentId, input.requestId);
    if (!(await this.store.denyRequest({ ...input, userId: actor.userId })))
      throw new AppError("CONFLICT");
    await this.decided(actor.workspaceId, input.requestId);
  }

  /** The decision is stored; a missed card refresh is repaired by browser reconciliation. */
  private async decided(workspaceId: string, requestId: string) {
    await this.requestDecided(workspaceId, requestId).catch(() => {});
  }

  /**
   * An Agent asks to use the app `appKey` with `requestedScopes` (the fixed scopes are always
   * added): granted, granted now for its first use, or waiting for a person's approval, whose
   * request is created once and then returned. Another use of the same app racing this one
   * cannot make a second grant or a second pending request.
   */
  async resolveAgentAccess(
    agent: { workspaceId: string; agentId: string },
    appKey: string,
    requestedScopes: string[] = [],
  ): Promise<AgentAccessOutcome> {
    const [found, app] = await Promise.all([
      this.store.findAgent(agent.workspaceId, agent.agentId),
      this.store.findInstalledApp(agent.workspaceId, appKey),
    ]);
    if (!found) throw new AppError("NOT_FOUND");
    if (!app) return { status: "not_installed" };
    for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
      const [grant, pendingRequest] = await Promise.all([
        this.store.findGrant(app.id, agent.agentId),
        this.store.findPendingRequest(app.id, agent.agentId),
      ]);
      const decision = decideAgentAccess({
        installed: true,
        allowedScopes: app.allowedScopes,
        requestedScopes,
        grant,
        inScope: agentInScope(app, agent.agentId),
        pendingRequest,
      });
      if (decision.kind === "not_installed") return { status: "not_installed" };
      if (decision.kind === "granted")
        return { status: "granted", scopes: decision.scopes, automatic: false };
      if (decision.kind === "needs_approval" && decision.pendingRequestId) {
        let scopes = decision.scopes;
        if (decision.widened) {
          const extended = await this.store.extendRequest({
            requestId: decision.pendingRequestId,
            scopes,
          });
          // The request was decided meanwhile: what the use gets now is decided again.
          if (!extended) continue;
          scopes = extended;
          // Its approval card shows the scopes it asks for.
          await this.decided(agent.workspaceId, decision.pendingRequestId);
        }
        return {
          status: "pending",
          requestId: decision.pendingRequestId,
          scopes,
          appName: app.name,
        };
      }
      const target = { appId: app.id, agentId: agent.agentId, workspaceId: agent.workspaceId };
      if (decision.kind === "grant_automatically") {
        const created = await this.store.createAutomaticGrant({
          ...target,
          scopes: decision.scopes,
          source: "automatic",
          grantedByUserId: null,
        });
        if (created) return { status: "granted", scopes: decision.scopes, automatic: true };
      } else {
        const requestId = await this.store.createRequest({ ...target, scopes: decision.scopes });
        if (requestId)
          return { status: "pending", requestId, scopes: decision.scopes, appName: app.name };
      }
    }
    throw new AppError("CONFLICT");
  }

  /** The actor may see the Agent; `canManage` says whether they may change its app access. */
  private async viewAgent(actor: AgentAppAccessActor, agentId: string) {
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

  private async manageAgent(actor: AgentAppAccessActor, agentId: string): Promise<void> {
    if (!(await this.viewAgent(actor, agentId)).canManage) throw new AppError("ACCESS_DENIED");
  }

  private async installedApp(workspaceId: string, appKey: string): Promise<InstalledApp> {
    const app = await this.store.findInstalledApp(workspaceId, appKey);
    if (!app) throw new AppError("NOT_FOUND");
    return app;
  }

  private async pendingRequest(agentId: string, requestId: string) {
    const request = await this.store.findRequest(agentId, requestId);
    if (!request) throw new AppError("NOT_FOUND");
    if (!request.pending) throw new AppError("CONFLICT");
    return request;
  }
}
