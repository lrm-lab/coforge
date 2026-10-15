import { describe, expect, test } from "bun:test";

import { WORKSPACE_ROLE_CAPABILITIES } from "#src/features/workspaces/workspace-role-capabilities";
import { WORKSPACE_MEMBER_ROLES } from "#src/features/workspaces/workspace-roles";

const rows = WORKSPACE_ROLE_CAPABILITIES.flatMap((group) =>
  group.rows.map((row) => ({ group: group.id, ...row })),
);
const holders = (id: string) =>
  WORKSPACE_MEMBER_ROLES.filter((role) => rows.find((row) => row.id === id)!.allows(role));

describe("the Workspace role matrix", () => {
  test("every member does everything under Using and nothing under Administration", () => {
    for (const row of rows)
      expect([row.id, row.allows("member")]).toEqual([row.id, row.group === "using"]);
  });

  test("an admin administers everything but the Workspace's URL and its deletion", () => {
    expect(rows.filter((row) => !row.allows("admin")).map((row) => row.id)).toEqual([
      "change-url",
      "delete-workspace",
    ]);
  });

  test("the owner can do everything", () => {
    for (const row of rows) expect([row.id, row.allows("owner")]).toEqual([row.id, true]);
  });

  test("creating and deleting Agents and managing members are owner and admin rights", () => {
    expect(holders("create-agents")).toEqual(["owner", "admin"]);
    expect(holders("delete-agents")).toEqual(["owner", "admin"]);
    expect(holders("manage-members")).toEqual(["owner", "admin"]);
  });
});
