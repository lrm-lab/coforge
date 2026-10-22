import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type { AppPermissionGroup } from "./app-permissions";

/** Each data group as the editor names and describes it; a `Record` so a new group cannot ship
 * without its copy. */
export const APP_PERMISSION_GROUP_COPY: Record<
  AppPermissionGroup,
  { label: () => string; description: () => string }
> = {
  workspace: {
    label: m.apps_permission_group_workspace,
    description: m.apps_permission_group_workspace_description,
  },
  agent: {
    label: m.apps_permission_group_agent,
    description: m.apps_permission_group_agent_description,
  },
  channel: {
    label: m.apps_permission_group_channel,
    description: m.apps_permission_group_channel_description,
  },
  computer: {
    label: m.apps_permission_group_computer,
    description: m.apps_permission_group_computer_description,
  },
};

/** `groups` named and joined as a sentence in the page's language. */
export function permissionGroupList(groups: readonly AppPermissionGroup[]): string {
  return new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(
    groups.map((group) => APP_PERMISSION_GROUP_COPY[group].label()),
  );
}
