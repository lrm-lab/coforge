import { AppError } from "#src/lib/app-error";
import {
  agentGrantScopes,
  allowedGrantScopes,
  grantCovers,
} from "#src/features/apps/agent-app-access";
import {
  roleCan,
  WORKSPACE_MEMBER_ROLES,
  type WorkspaceMemberRole,
} from "#src/features/workspaces/workspace-roles";

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
  /** The Agent's request for the app that waits for a person, and the scopes it asks for. */
  pendingRequest: { id: string; scopes: readonly string[] } | undefined;
};

export type AgentAccessDecision =
  | { kind: "not_installed" }
  /** The active grant covers the request; `scopes` are the grant's. */
  | { kind: "granted"; scopes: string[] }
  /** The Agent never had a grant for the app: it gets one now, with `scopes`. */
  | { kind: "grant_automatically"; scopes: string[] }
  /** A person must approve a grant of `scopes`: the grant was revoked, or does not cover the
   * request. `pendingRequestId` names the request already waiting, if there is one, and `scopes`
   * are then that request's. */
  | { kind: "needs_approval"; scopes: string[]; pendingRequestId?: string };

/**
 * The use-time rule: an app installed in a Workspace is usable by its Agents, granted
 * automatically the first time an Agent asks. Once a person revoked an Agent's grant, the Agent
 * needs a person's approval for that app again. A scope the app may not ask for is INVALID_INPUT.
 */
export function decideAgentAccess(facts: AgentAccessFacts): AgentAccessDecision {
  if (!facts.installed) return { kind: "not_installed" };
  const requested = agentGrantScopes(facts.requestedScopes, facts.allowedScopes);
  if (!requested) throw new AppError("INVALID_INPUT", { errorId: "app-scope-not-allowed" });
  const { grant, pendingRequest } = facts;
  if (!grant) return { kind: "grant_automatically", scopes: requested };
  if (!grant.revoked && grantCovers(grant.scopes, requested))
    return { kind: "granted", scopes: [...grant.scopes] };
  if (pendingRequest)
    return {
      kind: "needs_approval",
      scopes: [...pendingRequest.scopes],
      pendingRequestId: pendingRequest.id,
    };
  const scopes = grant.revoked
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
