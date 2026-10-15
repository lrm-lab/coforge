export const WORKSPACE_MEMBER_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number];

/** The roles with Workspace owner/admin authority. */
export const WORKSPACE_ADMIN_ROLES = [
  "owner",
  "admin",
] as const satisfies readonly WorkspaceMemberRole[];

/** Whether a stored role is a Workspace owner or admin; any other or missing role fails closed. */
export function isWorkspaceAdminRole(role: string | undefined): boolean {
  return WORKSPACE_ADMIN_ROLES.some((admin) => admin === role);
}

const EVERYONE = WORKSPACE_MEMBER_ROLES;
const OWNER_ONLY = ["owner"] as const satisfies readonly WorkspaceMemberRole[];

/**
 * The one table of what each Workspace role may do. The server's role checks
 * (`member-role.server.ts`, `channel-authority.server.ts`, and the helpers below) answer from it
 * through `roleCan`, and the role help (`workspace-role-capabilities.ts`) shows it, so a change
 * here changes both. Rules that are not about a Workspace role alone stay with their owners: who
 * may leave (`canLeaveWorkspace`), a channel admin's own channel, an Agent's creator.
 */
export const WORKSPACE_CAPABILITY_ROLES = {
  useChannels: EVERYONE,
  useDirectMessagesAndTasks: EVERYONE,
  addComputers: EVERYONE,
  controlAgentRuntime: EVERYONE,
  createAgents: WORKSPACE_ADMIN_ROLES,
  deleteAgents: WORKSPACE_ADMIN_ROLES,
  resetAgentWorkspace: WORKSPACE_ADMIN_ROLES,
  manageMembers: WORKSPACE_ADMIN_ROLES,
  manageChannels: WORKSPACE_ADMIN_ROLES,
  manageWorkspaceSettings: WORKSPACE_ADMIN_ROLES,
  changeWorkspaceSlug: OWNER_ONLY,
  deleteWorkspace: OWNER_ONLY,
} as const satisfies Record<string, readonly WorkspaceMemberRole[]>;

export type WorkspaceCapability = keyof typeof WORKSPACE_CAPABILITY_ROLES;

/** Whether a stored role holds `capability`; a missing or unknown role holds none. */
export function roleCan(role: string | undefined, capability: WorkspaceCapability): boolean {
  return (WORKSPACE_CAPABILITY_ROLES[capability] as readonly string[]).some(
    (holder) => holder === role,
  );
}

/** Whether a Workspace member's role manages Workspace-wide settings, such as its profile. */
export function canManageWorkspaceSettings(role: string | undefined): boolean {
  return roleCan(role, "manageWorkspaceSettings");
}

/** Whether a Workspace member's role invites members, changes their roles and removes them. */
export function canManageMembers(role: string | undefined): boolean {
  return roleCan(role, "manageMembers");
}

/** Whether a Workspace member may leave it: anyone but its owner. */
export function canLeaveWorkspace(role: string | undefined): boolean {
  return role !== undefined && role !== "owner";
}

/** Whether a Workspace member may change its URL (slug): its owner only. */
export function canChangeWorkspaceSlug(role: string | undefined): boolean {
  return roleCan(role, "changeWorkspaceSlug");
}

/** Whether a Workspace member may delete the Workspace for good: its owner only. */
export function canDeleteWorkspace(role: string | undefined): boolean {
  return roleCan(role, "deleteWorkspace");
}
