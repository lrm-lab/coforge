import { describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_CAPABILITIES } from "#src/features/workspaces/workspace-role-capabilities";
import {
  WORKSPACE_CAPABILITY_ROLES,
  canChangeWorkspaceSlug,
  canDeleteWorkspace,
  canManageMembers,
  canManageWorkspaceSettings,
  roleCan,
  type WorkspaceCapability,
} from "#src/features/workspaces/workspace-roles";
import {
  canDeleteChannel,
  canHideGeneralChannel,
  canListArchivedChannels,
  deriveChannelAdminBasis,
} from "#src/server/conversations/channel-authority.server";
import {
  assertCanDeleteAgents,
  assertHasAgentControlCapability,
  canCreateAgents,
} from "#src/server/workspaces/member-role.server";

const ROLES = ["owner", "admin", "member"] as const;
const passes = (check: () => void) => {
  try {
    check();
    return true;
  } catch {
    return false;
  }
};

describe("the Workspace capability table", () => {
  test("names who may do what", () => {
    const holders = (capability: WorkspaceCapability) =>
      ROLES.filter((role) => roleCan(role, capability));
    for (const capability of [
      "useChannels",
      "useDirectMessagesAndTasks",
      "addComputers",
      "controlAgentRuntime",
    ] as const)
      expect([capability, holders(capability)]).toEqual([capability, ["owner", "admin", "member"]]);
    for (const capability of [
      "createAgents",
      "deleteAgents",
      "resetAgentWorkspace",
      "manageMembers",
      "manageChannels",
      "manageWorkspaceSettings",
    ] as const)
      expect([capability, holders(capability)]).toEqual([capability, ["owner", "admin"]]);
    expect(holders("changeWorkspaceSlug")).toEqual(["owner"]);
    expect(holders("deleteWorkspace")).toEqual(["owner"]);
  });

  test("a missing or unknown role can do nothing", () => {
    for (const capability of Object.keys(WORKSPACE_CAPABILITY_ROLES) as WorkspaceCapability[]) {
      expect(roleCan(undefined, capability)).toBe(false);
      expect(roleCan("guest", capability)).toBe(false);
    }
  });

  test("every server check answers from the table", () => {
    for (const role of ROLES) {
      const can = (capability: WorkspaceCapability) => roleCan(role, capability);
      expect(canCreateAgents(role)).toBe(can("createAgents"));
      expect(passes(() => assertCanDeleteAgents(role))).toBe(can("deleteAgents"));
      expect(passes(() => assertHasAgentControlCapability(role, "controlAgentRuntime"))).toBe(
        can("controlAgentRuntime"),
      );
      expect(passes(() => assertHasAgentControlCapability(role, "resetAgentWorkspace"))).toBe(
        can("resetAgentWorkspace"),
      );
      expect(canManageMembers(role)).toBe(can("manageMembers"));
      expect(canManageWorkspaceSettings(role)).toBe(can("manageWorkspaceSettings"));
      expect(canChangeWorkspaceSlug(role)).toBe(can("changeWorkspaceSlug"));
      expect(canDeleteWorkspace(role)).toBe(can("deleteWorkspace"));
      expect(canDeleteChannel("random", role)).toBe(can("manageChannels"));
      expect(canHideGeneralChannel("general", role)).toBe(can("manageChannels"));
      expect(canListArchivedChannels(role)).toBe(can("manageChannels"));
      expect(deriveChannelAdminBasis(role, undefined) === "server_role").toBe(
        can("manageChannels"),
      );
    }
  });

  test("the role help shows exactly the table", () => {
    for (const group of WORKSPACE_ROLE_CAPABILITIES)
      for (const row of group.rows)
        for (const role of ROLES)
          expect([row.capability, role, row.allows(role)]).toEqual([
            row.capability,
            role,
            roleCan(role, row.capability),
          ]);
  });
});
