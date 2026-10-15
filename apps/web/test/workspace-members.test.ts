import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";
import { withFakePagination } from "./helpers/fake-paginated";

describe("WorkspaceMembers", () => {
  test("denies a User who is not a member before reading the directory", async () => {
    let directoryRead = false;
    const db = withFakePagination({
      workspaceMembership: { findUnique: async () => null },
      user: { findMany: async () => ((directoryRead = true), []) },
      agent: { findMany: async () => ((directoryRead = true), []) },
    }) as unknown as PrismaClient;

    await expect(
      new WorkspaceMembers(db).agentPage("workspace-1", "outsider", {
        owner: "all",
        query: "",
        limit: 24,
      }),
    ).rejects.toEqual(new AppError("ACCESS_DENIED"));
    expect(directoryRead).toBe(false);
  });

  test("returns all humans and Agents in the Workspace with only public directory fields", async () => {
    const queries: { membership?: object; people?: object; agents?: object } = {};
    const db = withFakePagination({
      workspaceMembership: {
        findUnique: async (query: object) => {
          queries.membership = query;
          return { userId: "viewer", role: "admin" };
        },
      },
      // The order of the page, which the database settles: the ids in the order to show.
      $queryRaw: async () => [{ id: "other-user" }],
      user: {
        findMany: async (query: object) => {
          queries.people = query;
          return [
            {
              id: "other-user",
              username: "grace",
              displayName: "Grace Hopper",
              description: "Compiler pioneer",
              email: "private@example.test",
              avatarObjectKey: "avatars/other-user/7f3a/avatar",
              agents: [],
            },
          ];
        },
      },
      agent: {
        update: async () => ({}),
        findMany: async (query: object) => {
          queries.agents = query;
          return [
            {
              id: "other-agent",
              name: "builder",
              displayName: "",
              description: "Builds releases",
              avatarObjectKey: "workspaces/workspace-1/agents/other-agent/avatars/pic-1/original",
              ownerId: "another-user",
              createdAt: new Date("2026-07-23T08:00:00.000Z"),
              owner: {
                id: "another-user",
                username: "ada",
                displayName: "  Ada Lovelace  ",
                avatarObjectKey: "avatars/another-user/9c1d/avatar",
              },
              runtimeConfig: { apiKey: "private" },
              computer: {
                id: "office-mac-id",
                name: "office-mac",
                displayName: "  Team workstation  ",
                workspaces: [{ id: "workspace-computer" }],
              },
            },
            {
              id: "detached-agent",
              name: "reviewer",
              displayName: "Reviewer",
              description: "Reviews changes",
              ownerId: "another-user",
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              owner: {
                id: "another-user",
                username: "ada",
                displayName: "Ada Lovelace",
                avatarObjectKey: null,
              },
              weeklyReportAssistant: { id: "assistant-1" },
              computer: { id: "other-machine-id", name: "other-workspace-machine", workspaces: [] },
            },
          ];
        },
      },
    }) as unknown as PrismaClient;

    const members = new WorkspaceMembers(db);
    const [people, agents] = await Promise.all([
      members.peoplePage("workspace-1", "viewer", { query: "", limit: 24 }),
      members.agentPage("workspace-1", "viewer", { owner: "all", query: "", limit: 24 }),
    ]);
    const result = { people: people.items, agents: agents.items };

    expect(queries.membership).toEqual({
      where: { workspaceId_userId: { workspaceId: "workspace-1", userId: "viewer" } },
      select: { userId: true, role: true },
    });
    expect(queries.people).toMatchObject({
      where: { id: { in: ["other-user"] } },
      select: {
        id: true,
        username: true,
        displayName: true,
        description: true,
        avatarObjectKey: true,
      },
    });
    expect(queries.agents).toMatchObject({
      where: { AND: [{ workspaceId: "workspace-1", deletedAt: null }, {}, {}] },
      select: {
        id: true,
        name: true,
        displayName: true,
        description: true,
        avatarObjectKey: true,
        createdAt: true,
        owner: { select: { id: true, username: true, displayName: true, avatarObjectKey: true } },
        weeklyReportAssistant: { select: { id: true } },
        computer: {
          select: {
            id: true,
            name: true,
            displayName: true,
            workspaces: {
              where: { workspaceId: "workspace-1" },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    expect(result).toEqual({
      people: [
        {
          id: "other-user",
          displayName: "Grace Hopper",
          description: "Compiler pioneer",
          avatarUrl: "/api/workspaces/workspace-1/users/other-user/avatar?v=7f3a",
          createdAgents: { total: 0, items: [] },
        },
      ],
      agents: [
        {
          id: "other-agent",
          name: "builder",
          displayName: "builder",
          description: "Builds releases",
          avatarUrl: "/api/workspaces/workspace-1/agents/other-agent/avatar?v=pic-1",
          computerId: "office-mac-id",
          computerName: "Team workstation",
          createdAt: new Date("2026-07-23T08:00:00.000Z"),
          owner: {
            id: "another-user",
            displayName: "Ada Lovelace",
            avatarUrl: "/api/workspaces/workspace-1/users/another-user/avatar?v=9c1d",
          },
          deletable: true,
        },
        {
          id: "detached-agent",
          name: "reviewer",
          displayName: "Ada Lovelace的周报助手",
          description: "Reviews changes",
          avatarUrl: null,
          computerId: null,
          computerName: null,
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          owner: { id: "another-user", displayName: "Ada Lovelace", avatarUrl: null },
          deletable: false,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("ownerId");
    expect(JSON.stringify(result)).not.toContain("avatarObjectKey");
  });

  test("hides a private Agent owned by someone else from a plain member's directory", async () => {
    let agentQuery: object | undefined;
    const db = withFakePagination({
      workspaceMembership: {
        findUnique: async () => ({ userId: "viewer", role: "member" }),
      },
      user: { findMany: async () => [] },
      agent: {
        findMany: async (query: object) => {
          agentQuery = query;
          return [];
        },
      },
    }) as unknown as PrismaClient;

    await new WorkspaceMembers(db).agentPage("workspace-1", "viewer", {
      owner: "all",
      query: "",
      limit: 24,
    });

    const [visible] = (agentQuery as { where: { AND: object[] } }).where.AND;
    expect(visible).toEqual({
      workspaceId: "workspace-1",
      deletedAt: null,
      OR: [{ visibility: "public" }, { ownerId: "viewer" }],
    });
  });

  test("an owner/admin's directory query has nothing to hide", async () => {
    let agentQuery: object | undefined;
    const db = withFakePagination({
      workspaceMembership: {
        findUnique: async () => ({ userId: "viewer", role: "admin" }),
      },
      user: { findMany: async () => [] },
      agent: {
        findMany: async (query: object) => {
          agentQuery = query;
          return [];
        },
      },
    }) as unknown as PrismaClient;

    await new WorkspaceMembers(db).agentPage("workspace-1", "viewer", {
      owner: "all",
      query: "",
      limit: 24,
    });

    const [visible] = (agentQuery as { where: { AND: object[] } }).where.AND;
    expect(visible).toEqual({ workspaceId: "workspace-1", deletedAt: null });
  });
  describe("directory", () => {
    const directoryOf = (people: object[]) =>
      new WorkspaceMembers({
        workspaceMembership: { findUnique: async () => ({ userId: "viewer", role: "member" }) },
        user: { findMany: async () => people },
        agent: {
          findMany: async () => [
            {
              id: "agent-1",
              name: "atlas",
              displayName: "Atlas Bot",
              avatarObjectKey: null,
              ownerId: "viewer",
            },
          ],
        },
        conversationMember: { findMany: async () => [] },
      } as unknown as PrismaClient).directory("workspace-1", "viewer");

    test("a person carries the names they are shown by and no username", async () => {
      const { people } = await directoryOf([
        {
          id: "user-1",
          username: "grace-hopper-4k2",
          displayName: "Amazing Grace",
          avatarObjectKey: null,
        },
        {
          id: "user-2",
          username: "ada-9d3",
          displayName: "  ",
          avatarObjectKey: null,
        },
      ]);
      // Listed by the name shown; a person with a blank name is shown as unnamed, never by
      // their username.
      expect(people).toEqual([
        {
          id: "user-1",
          name: "Amazing Grace",
          avatarUrl: null,
          dmId: null,
        },
        { id: "user-2", name: UNNAMED_PERSON_NAME, avatarUrl: null, dmId: null },
      ]);
      expect(JSON.stringify(people)).not.toContain("grace-hopper-4k2");
      expect(JSON.stringify(people)).not.toContain("ada-9d3");
    });

    test("an Agent keeps its @handle", async () => {
      const { agents } = await directoryOf([]);
      expect(agents).toMatchObject([{ id: "agent-1", handle: "atlas", name: "Atlas Bot" }]);
    });
  });

  describe("person", () => {
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
                  avatarObjectKey: null,
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
            avatarUrl: null,
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
      // Nobody changes or removes the owner; a plain member manages no one.
      expect(await actions("admin", "target", "owner")).toEqual({
        canChangeRole: false,
        canRemove: false,
      });
      expect(await actions("member", "target", "member")).toEqual({
        canChangeRole: false,
        canRemove: false,
      });
      // An admin may change their own role but leaves instead of removing themself.
      expect(await actions("admin", "viewer", "admin")).toEqual({
        canChangeRole: true,
        canRemove: false,
      });
    });
  });
});
