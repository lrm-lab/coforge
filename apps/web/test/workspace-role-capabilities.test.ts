import { describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_CAPABILITIES } from "#src/features/workspaces/workspace-role-capabilities";
import {
  WORKSPACE_MEMBER_ROLES,
  type WorkspaceCapability,
} from "#src/features/workspaces/workspace-roles";

const rows = WORKSPACE_ROLE_CAPABILITIES.flatMap((group) =>
  group.rows.map((row) => ({ group: group.id, ...row })),
);
const holders = (id: WorkspaceCapability) =>
  WORKSPACE_MEMBER_ROLES.filter((role) => rows.find((row) => row.capability === id)!.allows(role));

describe("the Workspace role matrix", () => {
  test("every member does everything under Using and nothing under Administration", () => {
    for (const row of rows)
      expect([row.capability, row.allows("member")]).toEqual([
        row.capability,
        row.group === "using",
      ]);
  });

  test("an admin administers everything but the Workspace's URL and its deletion", () => {
    expect(rows.filter((row) => !row.allows("admin")).map((row) => row.capability)).toEqual([
      "changeWorkspaceSlug",
      "deleteWorkspace",
    ]);
  });

  test("the owner can do everything", () => {
    for (const row of rows)
      expect([row.capability, row.allows("owner")]).toEqual([row.capability, true]);
  });

  test("creating and deleting Agents and managing members are owner and admin rights", () => {
    expect(holders("createAgents")).toEqual(["owner", "admin"]);
    expect(holders("deleteAgents")).toEqual(["owner", "admin"]);
    expect(holders("manageMembers")).toEqual(["owner", "admin"]);
  });
});
