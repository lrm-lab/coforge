import { describe, expect, test } from "bun:test";
import { personAvatarUrl } from "#src/lib/person-picture";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";
import { withFakePagination } from "./helpers/fake-paginated";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";

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
              memberships: [{ role: "admin" }],
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
              avatarMascot: "pink",
              ownerId: "another-user",
              visibility: "public",
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
                kind: "local",
                workspaces: [{ id: "workspace-computer" }],
              },
            },
            {
              id: "detached-agent",
              name: "reviewer",
              displayName: "Reviewer",
              description: "Reviews changes",
              ownerId: "another-user",
              visibility: "private",
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              owner: {
                id: "another-user",
                username: "ada",
                displayName: "Ada Lovelace",
                avatarObjectKey: null,
              },
              weeklyReportAssistant: { id: "assistant-1" },
              computer: {
                id: "other-machine-id",
                name: "other-workspace-machine",
                displayName: "",
                kind: "cloud",
                workspaces: [],
              },
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
      select: {
        userId: true,
        role: true,
        workspace: { select: { experiments: true } },
      },
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
      where: {
        AND: [
          {
            AND: [
              { workspaceId: "workspace-1", deletedAt: null },
              { OR: [{ systemKind: null }, { systemKind: { not: "app-bot" } }] },
            ],
          },
          {},
          {},
        ],
      },
      select: {
        id: true,
        name: true,
        displayName: true,
        description: true,
        avatarMascot: true,
        createdAt: true,
        owner: { select: { id: true, username: true, displayName: true, avatarObjectKey: true } },
        weeklyReportAssistant: { select: { id: true } },
        computer: {
          select: {
            id: true,
            name: true,
            displayName: true,
            kind: true,
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
          role: "admin",
          createdAgents: { total: 0, items: [] },
        },
      ],
      agents: [
        {
          id: "other-agent",
          name: "builder",
          displayName: "builder",
          description: "Builds releases",
          avatarUrl: agentAvatarUrl("other-agent", "pink"),
          model: "",
          computerId: "office-mac-id",
          computerKind: "local",
          computerName: "Team workstation",
          computerRevoked: false,
          createdAt: new Date("2026-07-23T08:00:00.000Z"),
          owner: {
            id: "another-user",
            displayName: "Ada Lovelace",
            avatarUrl: "/api/workspaces/workspace-1/users/another-user/avatar?v=9c1d",
          },
          canMessage: true,
          deletable: true,
        },
        {
          id: "detached-agent",
          name: "reviewer",
          // Task #495: the directory shows the stored display name, not a name recomputed on read.
          displayName: "Reviewer",
          description: "Reviews changes",
          avatarUrl: agentAvatarUrl("detached-agent"),
          model: "",
          computerId: null,
          computerKind: null,
          computerName: "other-workspace-machine",
          computerRevoked: true,
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          owner: {
            id: "another-user",
            displayName: "Ada Lovelace",
            avatarUrl: personAvatarUrl("another-user", null),
          },
          canMessage: false,
          deletable: false,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("ownerId");
    expect(JSON.stringify(result)).not.toContain("avatarMascot");
  });

  test("a weekly-report assistant is shown by its stored name, without renaming on read", async () => {
    // Task #495: the directory reads the stored display name like any other Agent. The owner's
    // name and language changes rename the assistant directly (`renameOwnerAgents`); the page
    // neither recomputes the name nor writes it, and asks for no per-row owner language.
    const renamed: string[] = [];
    const stored = ["Ada's Weekly Report Assistant", "李健的周报助手", "My own name for it"];
    const db = withFakePagination({
      workspaceMembership: { findUnique: async () => ({ userId: "viewer", role: "admin" }) },
      agent: {
        update: async ({ data }: { data: { displayName: string } }) => {
          renamed.push(data.displayName);
          return {};
        },
        findMany: async () =>
          stored.map((displayName, index) => ({
            id: `agent-${index}`,
            name: `weekly-${index}`,
            displayName,
            description: "",
            avatarMascot: null,
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
            owner: {
              id: `user-${index}`,
              username: `user-${index}`,
              displayName: `owner-${index}`,
              avatarObjectKey: null,
            },
            weeklyReportAssistant: { id: `assistant-${index}` },
            computer: null,
          })),
      },
    }) as unknown as PrismaClient;

    const page = await new WorkspaceMembers(db).agentPage("workspace-1", "viewer", {
      owner: "all",
      query: "",
      limit: 24,
    });

    expect(page.items.map((agent) => agent.displayName)).toEqual(stored);
    // No rename on read, for any row.
    expect(renamed).toEqual([]);
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

    const [roster] = (agentQuery as { where: { AND: Array<{ AND: object[] }> } }).where.AND;
    const [visible] = roster.AND;
    expect(visible).toEqual({
      workspaceId: "workspace-1",
      deletedAt: null,
      weeklyReportAssistant: null,
      weeklyReportCollectorBinding: null,
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
    });
  });

  test("an owner/admin directory excludes other people's platform assistants", async () => {
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

    const [roster] = (agentQuery as { where: { AND: Array<{ AND: object[] }> } }).where.AND;
    const [visible] = roster.AND;
    expect(visible).toEqual({
      workspaceId: "workspace-1",
      deletedAt: null,
      weeklyReportAssistant: null,
      weeklyReportCollectorBinding: null,
      OR: [
        { systemKind: null },
        { systemKind: { not: "workspace-assistant" } },
        { ownerId: "viewer" },
      ],
    });
  });

  test("includes weekly-report assistants in the directory once the workspace enables weeklyReports", async () => {
    let agentQuery: object | undefined;
    const db = withFakePagination({
      workspaceMembership: {
        findUnique: async () => ({
          userId: "viewer",
          role: "admin",
          workspace: { experiments: { weeklyReports: true } },
        }),
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

    const [roster] = (agentQuery as { where: { AND: Array<{ AND: object[] }> } }).where.AND;
    const [visible] = roster.AND;
    expect(visible).toEqual({
      workspaceId: "workspace-1",
      deletedAt: null,
      OR: [
        { systemKind: null },
        { systemKind: { not: "workspace-assistant" } },
        { ownerId: "viewer" },
      ],
    });
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
              avatarMascot: null,
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
          avatarUrl: personAvatarUrl("user-1", null),
          dmId: null,
        },
        {
          id: "user-2",
          name: UNNAMED_PERSON_NAME,
          avatarUrl: personAvatarUrl("user-2", null),
          dmId: null,
        },
      ]);
      expect(JSON.stringify(people)).not.toContain("grace-hopper-4k2");
      expect(JSON.stringify(people)).not.toContain("ada-9d3");
    });

    test("an Agent keeps its @handle", async () => {
      const { agents } = await directoryOf([]);
      expect(agents).toMatchObject([{ id: "agent-1", handle: "atlas", name: "Atlas Bot" }]);
    });
  });
});
