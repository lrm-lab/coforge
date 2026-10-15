import { AppError } from "#src/lib/app-error";
import {
  canDeleteWorkspace,
  canLeaveWorkspace,
  canManageMembers,
  canManageWorkspaceSettings,
  isWorkspaceAdminRole,
  roleCan,
  WORKSPACE_MEMBER_ROLES,
  type WorkspaceMemberRole,
} from "#src/features/workspaces/workspace-roles";

export { WORKSPACE_MEMBER_ROLES, type WorkspaceMemberRole };

export const ASSIGNABLE_WORKSPACE_ROLES = ["admin", "member"] as const;
export type AssignableWorkspaceRole = (typeof ASSIGNABLE_WORKSPACE_ROLES)[number];

export function isWorkspaceMemberRole(value: string): value is WorkspaceMemberRole {
  return (WORKSPACE_MEMBER_ROLES as readonly string[]).includes(value);
}

export function isAdminLike(role: WorkspaceMemberRole): boolean {
  return isWorkspaceAdminRole(role);
}

/** An actor's stored server role (human `WorkspaceMembership.role` or `Agent.role`) counts as
 * owner/admin only when it is a recognized role; a missing or unknown value fails closed. */
export function isElevatedServerRole(role: string | undefined): boolean {
  return isWorkspaceAdminRole(role);
}

/** Workspace-wide settings, such as hiding `#general`, are Workspace owner/admin only. */
export function assertCanManageWorkspaceSettings(actorRole: string | undefined): void {
  if (!canManageWorkspaceSettings(actorRole)) throw new AppError("ACCESS_DENIED");
}

export function assertCanManageMembers(actorRole: WorkspaceMemberRole): void {
  if (!canManageMembers(actorRole)) throw new AppError("ACCESS_DENIED");
}

/** Creating an Agent requires the `createAgents` capability, kept as its own named seam. */
export function canCreateAgents(actorRole: string | undefined): boolean {
  return roleCan(actorRole, "createAgents");
}

export function assertCanCreateAgents(actorRole: WorkspaceMemberRole): void {
  if (!canCreateAgents(actorRole)) throw new AppError("ACCESS_DENIED");
}

/**
 * Deleting an Agent needs the `deleteAgents` capability (`WORKSPACE_CAPABILITY_ROLES`), which a
 * plain member does not hold — not even for an Agent they created.
 */
export function assertCanDeleteAgents(actorRole: WorkspaceMemberRole): void {
  if (!roleCan(actorRole, "deleteAgents")) throw new AppError("ACCESS_DENIED");
}

/**
 * The two capabilities `AgentControl.execute()` checks for a user-initiated Restart, Reset session
 * or Full reset; who holds each is in `WORKSPACE_CAPABILITY_ROLES`.
 */
export const AGENT_CONTROL_CAPABILITIES = ["controlAgentRuntime", "resetAgentWorkspace"] as const;
export type AgentControlCapability = (typeof AGENT_CONTROL_CAPABILITIES)[number];

function hasAgentControlCapability(
  actorRole: WorkspaceMemberRole,
  capability: AgentControlCapability,
): boolean {
  return roleCan(actorRole, capability);
}

export function assertHasAgentControlCapability(
  actorRole: WorkspaceMemberRole,
  capability: AgentControlCapability,
): void {
  if (!hasAgentControlCapability(actorRole, capability)) throw new AppError("ACCESS_DENIED");
}

export function normalizeAssignableRole(role: string): AssignableWorkspaceRole {
  if (role === "admin" || role === "member") return role;
  throw new AppError("INVALID_INPUT");
}

/** Whether `actorRole` may give someone `role`: only owners and admins do, and never `owner`. */
export function assertCanAssignRole(
  actorRole: WorkspaceMemberRole,
  role: string,
): AssignableWorkspaceRole {
  assertCanManageMembers(actorRole);
  return normalizeAssignableRole(role);
}

export function assertCanChangeMemberRole(
  actorRole: WorkspaceMemberRole,
  targetRole: WorkspaceMemberRole,
  nextRole: string,
): WorkspaceMemberRole {
  assertCanManageMembers(actorRole);
  if (!isWorkspaceMemberRole(nextRole)) throw new AppError("INVALID_INPUT");
  if (targetRole === "owner" || nextRole === "owner") throw new AppError("CONFLICT");
  return nextRole;
}

export function assertCanRemoveMember(
  actorRole: WorkspaceMemberRole,
  targetRole: WorkspaceMemberRole,
): void {
  assertCanManageMembers(actorRole);
  if (targetRole === "owner") throw new AppError("CONFLICT");
}

export function assertCanLeaveWorkspace(actorRole: WorkspaceMemberRole): void {
  if (!canLeaveWorkspace(actorRole)) throw new AppError("CONFLICT");
}

export function assertCanDeleteWorkspace(actorRole: string | undefined): void {
  if (!canDeleteWorkspace(actorRole)) throw new AppError("ACCESS_DENIED");
}
