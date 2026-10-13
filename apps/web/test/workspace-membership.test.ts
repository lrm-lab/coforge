import { describe, expect, test } from "bun:test";

import {
  requireWorkspaceMember,
  workspaceMemberRole,
} from "#src/server/workspaces/workspace-membership.server";

/** A membership table holding exactly these rows, recording the lookups it answers. */
function memberships(rows: { workspaceId: string; userId: string; role: string }[]) {
  const lookups: unknown[] = [];
  const db = {
    workspaceMembership: {
      findUnique: async (args: {
        where: { workspaceId_userId: { workspaceId: string; userId: string } };
        select: Record<string, true>;
      }) => {
        lookups.push(args);
        const { workspaceId, userId } = args.where.workspaceId_userId;
        const row = rows.find((r) => r.workspaceId === workspaceId && r.userId === userId);
        return row
          ? Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k as "role"]]))
          : null;
      },
    },
  };
  return { db: db as never, lookups };
}

const rows = [{ workspaceId: "w1", userId: "u1", role: "admin" }];

describe("requireWorkspaceMember", () => {
  test("a member passes, looked up by the Workspace and user pair", async () => {
    const { db, lookups } = memberships(rows);
    await expect(requireWorkspaceMember(db, "w1", "u1")).resolves.toBeUndefined();
    expect(lookups).toEqual([
      {
        where: { workspaceId_userId: { workspaceId: "w1", userId: "u1" } },
        select: { userId: true },
      },
    ]);
  });

  test("a user who is not a member of this Workspace is refused", async () => {
    const { db } = memberships(rows);
    await expect(requireWorkspaceMember(db, "w2", "u1")).rejects.toThrow("ACCESS_DENIED");
    await expect(requireWorkspaceMember(db, "w1", "u2")).rejects.toThrow("ACCESS_DENIED");
  });
});

describe("workspaceMemberRole", () => {
  test("a member's role comes back", async () => {
    const { db } = memberships(rows);
    expect(await workspaceMemberRole(db, "w1", "u1")).toBe("admin");
  });

  test("a non-member is refused instead of getting a role", async () => {
    const { db } = memberships(rows);
    await expect(workspaceMemberRole(db, "w1", "u2")).rejects.toThrow("ACCESS_DENIED");
  });
});
