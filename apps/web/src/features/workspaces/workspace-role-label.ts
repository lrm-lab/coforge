import { m } from "#src/paraglide/messages";

/** A Workspace role as people read it. */
export function workspaceRoleLabel(role: string) {
  if (role === "owner") return m.workspace_role_owner();
  if (role === "admin") return m.workspace_role_admin();
  return m.workspace_role_member();
}
