import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { AppError } from "#src/lib/app-error";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";

describe("WorkspaceMembers.person", () => {
  type MembershipQuery = { where: { workspaceId_userId: { userId: string } } };
  const personOf = (memberships: Record<string, object>, queries: MembershipQuery[] = []) =>
    new WorkspaceMembers({
      workspaceMembership: {
        findUnique: async (query: MembershipQuery) => {
          queries.push(query);
          return memberships[query.where.workspaceId_userId.userId] ?? null;
        },
      },
      agent: { update: async () => ({}) },
    } as unknown as PrismaClient);

  test("denies a viewer who is not a member before reading anyone", async () => {
    const queries: MembershipQuery[] = [];
    await expect(
      personOf({ grace: { role: "member" } }, queries).person("workspace-1", "outsider", "grace"),
    ).rejects.toEqual(new AppError("ACCESS_DENIED"));
    expect(queries).toHaveLength(1);
  });

  test("a person who is not a member of the Workspace is not found", async () => {
    await expect(
      personOf({ viewer: { userId: "viewer", role: "member" } }).person(
        "workspace-1",
        "viewer",
        "stranger",
      ),
    ).rejects.toEqual(new AppError("NOT_FOUND"));
  });

  test("shows a member's name, description, email, role, join date and the Agents the viewer may see", async () => {
    const queries: MembershipQuery[] = [];
    const result = await personOf(
      {
        viewer: { userId: "viewer", role: "member" },
        grace: {
          role: "admin",
          createdAt: new Date("2026-06-24T00:00:00.000Z"),
          user: {
            id: "grace",
            username: "grace-hopper-4k2",
            displayName: "Grace Hopper",
            description: "Compiler pioneer",
            email: "grace@example.test",
            avatarObjectKey: "avatars/grace/7f3a/avatar",
            agents: [
              {
                id: "agent-1",
                name: "cobol",
                displayName: "COBOL",
                description: "Writes reports",
                avatarMascot: null,
                weeklyReportAssistant: null,
              },
            ],
          },
        },
      },
      queries,
    ).person("workspace-1", "viewer", "grace");

    expect(queries[1]).toMatchObject({
      where: { workspaceId_userId: { workspaceId: "workspace-1", userId: "grace" } },
      select: {
        role: true,
        createdAt: true,
        user: {
          select: {
            agents: {
              where: {
                workspaceId: "workspace-1",
                deletedAt: null,
                OR: [{ visibility: "public" }, { ownerId: "viewer" }],
                AND: [
                  {
                    OR: [
                      { systemKind: null },
                      { systemKind: { not: "workspace-assistant" } },
                      { ownerId: "viewer" },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(result).toEqual({
      id: "grace",
      displayName: "Grace Hopper",
      description: "Compiler pioneer",
      email: "grace@example.test",
      avatarUrl: "/api/workspaces/workspace-1/users/grace/avatar?v=7f3a",
      role: "admin",
      joinedAt: new Date("2026-06-24T00:00:00.000Z"),
      isViewer: false,
      canChangeRole: false,
      canRemove: false,
      createdAgents: [
        {
          id: "agent-1",
          displayName: "COBOL",
          avatarUrl: agentAvatarUrl("agent-1"),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("grace-hopper-4k2");
  });

  test("marks the viewer's own profile", async () => {
    const result = await personOf({
      viewer: {
        userId: "viewer",
        role: "owner",
        createdAt: new Date("2026-06-11T00:00:00.000Z"),
        user: {
          id: "viewer",
          username: "viewer",
          displayName: "Vera Viewer",
          description: "",
          email: null,
          avatarObjectKey: null,
          agents: [],
        },
      },
    }).person("workspace-1", "viewer", "viewer");
    expect(result).toMatchObject({ id: "viewer", displayName: "Vera Viewer", isViewer: true });
  });

  test("offers an owner or admin the role change and removal Settings → Members allows", async () => {
    const member = (role: string, id = "target") => ({
      role,
      createdAt: new Date("2026-06-24T00:00:00.000Z"),
      user: {
        id,
        username: id,
        displayName: `Person ${id}`,
        description: "",
        email: null,
        avatarObjectKey: null,
        agents: [],
      },
    });
    const actions = async (viewerRole: string, target: string, targetRole: string) => {
      const result = await personOf({
        viewer: target === "viewer" ? member(viewerRole, "viewer") : { role: viewerRole },
        ...(target === "viewer" ? {} : { target: member(targetRole) }),
      }).person("workspace-1", "viewer", target);
      return { canChangeRole: result.canChangeRole, canRemove: result.canRemove };
    };
    expect(await actions("admin", "target", "member")).toEqual({
      canChangeRole: true,
      canRemove: true,
    });
    expect(await actions("owner", "target", "admin")).toEqual({
      canChangeRole: true,
      canRemove: true,
    });
    expect(await actions("admin", "target", "owner")).toEqual({
      canChangeRole: false,
      canRemove: false,
    });
    expect(await actions("member", "target", "member")).toEqual({
      canChangeRole: false,
      canRemove: false,
    });
    expect(await actions("admin", "viewer", "admin")).toEqual({
      canChangeRole: true,
      canRemove: false,
    });
  });
});
