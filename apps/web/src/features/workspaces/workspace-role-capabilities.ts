import { m } from "#src/paraglide/messages";
import {
  canChangeWorkspaceSlug,
  canDeleteWorkspace,
  canManageMembers,
  canManageWorkspaceSettings,
  isWorkspaceAdminRole,
  type WorkspaceMemberRole,
} from "./workspace-roles";

type Capability = {
  id: string;
  label: () => string;
  allows: (role: WorkspaceMemberRole) => boolean;
};

const everyone = () => true;

/**
 * What each Workspace role may do, as the role help shows it: capabilities by role, grouped like
 * Slack's "Permissions by role". Each row answers from the same role rule the server enforces
 * (`workspace-roles.ts`, which `member-role.server.ts` builds on), so the help cannot drift from
 * the checks. Agent-config edits are left out: only an Agent's creator edits it, whatever the role.
 */
export const WORKSPACE_ROLE_CAPABILITIES: {
  id: "using" | "administration";
  label: () => string;
  rows: Capability[];
}[] = [
  {
    id: "using",
    label: () => m.workspace_roles_group_using(),
    rows: [
      { id: "channels", label: () => m.workspace_roles_can_channels(), allows: everyone },
      { id: "dms-and-tasks", label: () => m.workspace_roles_can_dms_tasks(), allows: everyone },
      { id: "computers", label: () => m.workspace_roles_can_computers(), allows: everyone },
      { id: "run-agents", label: () => m.workspace_roles_can_run_agents(), allows: everyone },
    ],
  },
  {
    id: "administration",
    label: () => m.workspace_roles_group_administration(),
    rows: [
      {
        id: "create-agents",
        label: () => m.workspace_roles_can_create_agents(),
        allows: isWorkspaceAdminRole,
      },
      {
        id: "delete-agents",
        label: () => m.workspace_roles_can_delete_agents(),
        allows: isWorkspaceAdminRole,
      },
      {
        id: "manage-members",
        label: () => m.workspace_roles_can_manage_members(),
        allows: canManageMembers,
      },
      {
        id: "manage-channels",
        label: () => m.workspace_roles_can_manage_channels(),
        allows: isWorkspaceAdminRole,
      },
      {
        id: "workspace-profile",
        label: () => m.workspace_roles_can_workspace_profile(),
        allows: canManageWorkspaceSettings,
      },
      {
        id: "change-url",
        label: () => m.workspace_roles_can_change_url(),
        allows: canChangeWorkspaceSlug,
      },
      {
        id: "delete-workspace",
        label: () => m.workspace_roles_can_delete_workspace(),
        allows: canDeleteWorkspace,
      },
    ],
  },
];
