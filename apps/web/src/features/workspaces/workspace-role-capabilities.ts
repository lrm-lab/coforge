import { m } from "#src/paraglide/messages";
import { roleCan, type WorkspaceCapability, type WorkspaceMemberRole } from "./workspace-roles";

type CapabilityRow = {
  capability: WorkspaceCapability;
  label: () => string;
  allows: (role: WorkspaceMemberRole) => boolean;
};

const row = (capability: WorkspaceCapability, label: () => string): CapabilityRow => ({
  capability,
  label,
  allows: (role) => roleCan(role, capability),
});

/**
 * What each Workspace role may do, as the role help shows it: capabilities by role, grouped like
 * Slack's "Permissions by role". Every cell reads `WORKSPACE_CAPABILITY_ROLES`, the table the
 * server's role checks answer from, so the help cannot drift from them. Agent-config edits are left
 * out: only an Agent's creator edits it, whatever the role.
 */
export const WORKSPACE_ROLE_CAPABILITIES: {
  id: "using" | "administration";
  label: () => string;
  rows: CapabilityRow[];
}[] = [
  {
    id: "using",
    label: () => m.workspace_roles_group_using(),
    rows: [
      row("useChannels", () => m.workspace_roles_can_channels()),
      row("useDirectMessagesAndTasks", () => m.workspace_roles_can_dms_tasks()),
      row("addComputers", () => m.workspace_roles_can_computers()),
      row("controlAgentRuntime", () => m.workspace_roles_can_run_agents()),
    ],
  },
  {
    id: "administration",
    label: () => m.workspace_roles_group_administration(),
    rows: [
      row("createAgents", () => m.workspace_roles_can_create_agents()),
      row("deleteAgents", () => m.workspace_roles_can_delete_agents()),
      row("manageMembers", () => m.workspace_roles_can_manage_members()),
      row("manageChannels", () => m.workspace_roles_can_manage_channels()),
      row("manageWorkspaceSettings", () => m.workspace_roles_can_workspace_profile()),
      row("changeWorkspaceSlug", () => m.workspace_roles_can_change_url()),
      row("deleteWorkspace", () => m.workspace_roles_can_delete_workspace()),
    ],
  },
];
