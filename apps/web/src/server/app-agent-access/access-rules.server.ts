import { AppError } from "#src/lib/app-error";
import {
  agentGrantScopes,
  allowedGrantScopes,
  grantCovers,
} from "#src/features/apps/agent-app-access";
import type { AgentAccessMode } from "#src/features/apps/agent-access-scope";
import {
  roleCan,
  WORKSPACE_MEMBER_ROLES,
  type WorkspaceMemberRole,
} from "#src/features/workspaces/workspace-roles";

/** An INVALID_INPUT (`app-scope-not-allowed`) that names the scopes the app does not allow. */
export class AppScopeNotAllowedError extends AppError {
  constructor(readonly scopes: readonly string[]) {
    super("INVALID_INPUT", { errorId: "app-scope-not-allowed" });
  }
}

/** Which Agents an installation lets use its app (`features/apps/agent-access-scope`). */
export type AgentScope = {
  agentAccess: AgentAccessMode;
  /** The selected Agents; used only while `agentAccess` is `selected`. */
  selectedAgentIds: readonly string[];
};

/** Whether the installation's scope includes the Agent: every Agent under `all`, only the
 * selection under `selected`. */
export const agentInScope = (scope: AgentScope, agentId: string) =>
  scope.agentAccess === "all" || scope.selectedAgentIds.includes(agentId);

/** The apps the Agent is told about: those whose scope includes it, and those it holds an active
 * grant for, since a person's grant works for any Agent. */
export function appsVisibleToAgent<App extends AgentScope & { id: string }>(
  apps: readonly App[],
  grants: readonly { appId: string; revoked: boolean }[],
  agentId: string,
): App[] {
  return apps.filter(
    (app) =>
      agentInScope(app, agentId) ||
      grants.some((grant) => grant.appId === app.id && !grant.revoked),
  );
}

/** What is known when an Agent asks to use an app: the facts `decideAgentAccess` judges. */
export type AgentAccessFacts = {
  /** Whether the app is installed in the Agent's Workspace. */
  installed: boolean;
  /** The scopes the app may ask for. */
  allowedScopes: readonly string[];
  /** The scopes the Agent asks for; the fixed ones are always added. */
  requestedScopes: readonly string[];
  /** The Agent's grant for the app, active or revoked; `undefined` when it never had one. */
  grant: { scopes: readonly string[]; revoked: boolean } | undefined;
  /** Whether the installation's scope includes the Agent (`agentInScope`). */
  inScope: boolean;
  /** The Agent's request for the app that waits for a person, and the scopes it asks for. */
  pendingRequest: { id: string; scopes: readonly string[] } | undefined;
};

export type AgentAccessDecision =
  | { kind: "not_installed" }
  /** The active grant covers the request; `scopes` are the grant's the app still allows, so
   * narrowing an app's allowed scopes takes effect for the next token. */
  | { kind: "granted"; scopes: string[] }
  /** The Agent never had a grant for the app and the app's scope includes it: it gets one now,
   * with `scopes`. */
  | { kind: "grant_automatically"; scopes: string[] }
  /**
   * A person must approve a grant of `scopes`: the grant was revoked or does not cover the
   * request, or the Agent has none and is outside a Selected Agents scope. `pendingRequestId`
   * names the request already waiting, if there is one, and `scopes` are then that request's and
   * the ones this use asks for.
   */
  | {
      kind: "needs_approval";
      scopes: string[];
      pendingRequestId?: string;
      /** The waiting request lacks scopes this use asks for: `scopes` are more than it holds. */
      widened?: true;
    };

/**
 * The use-time rule: an app installed in a Workspace is usable by its Agents, granted
 * automatically the first time an Agent asks. Once a person revoked an Agent's grant, the Agent
 * needs a person's approval for that app again; so does an Agent outside an installation's Selected
 * Agents that has no grant. A scope the app may not ask for is INVALID_INPUT.
 */
export function decideAgentAccess(facts: AgentAccessFacts): AgentAccessDecision {
  if (!facts.installed) return { kind: "not_installed" };
  const requested = agentGrantScopes(facts.requestedScopes, facts.allowedScopes);
  if (!requested)
    throw new AppScopeNotAllowedError(
      facts.requestedScopes.filter((scope) => !facts.allowedScopes.includes(scope)),
    );
  const { grant, pendingRequest } = facts;
  if (grant && !grant.revoked && grantCovers(grant.scopes, requested))
    return { kind: "granted", scopes: allowedGrantScopes(grant.scopes, facts.allowedScopes) };
  if (!grant && facts.inScope) return { kind: "grant_automatically", scopes: requested };
  if (pendingRequest) {
    // The waiting request also asks for what this use needs and it lacks.
    const scopes = allowedGrantScopes(
      [...pendingRequest.scopes, ...requested],
      facts.allowedScopes,
    );
    return {
      kind: "needs_approval",
      scopes,
      pendingRequestId: pendingRequest.id,
      ...(grantCovers(pendingRequest.scopes, scopes) ? {} : { widened: true as const }),
    };
  }
  const scopes =
    !grant || grant.revoked
      ? requested
      : allowedGrantScopes([...grant.scopes, ...requested], facts.allowedScopes);
  return { kind: "needs_approval", scopes };
}

/**
 * Whether a person may grant, revoke, approve and deny an Agent's app access: a Workspace owner or
 * admin, or the Agent's creator while they are a member (`role` is their Workspace role).
 */
export function canManageAgentAppAccess(
  viewer: { userId: string; role: WorkspaceMemberRole | undefined },
  agent: { ownerId: string },
): boolean {
  if (roleCan(viewer.role, "manageAgentAppAccess")) return true;
  // A stored role outside the known ones fails closed, the creator's included.
  const member = WORKSPACE_MEMBER_ROLES.some((role) => role === viewer.role);
  return member && agent.ownerId === viewer.userId;
}
