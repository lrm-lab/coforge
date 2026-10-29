import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { RecordCatalog } from "#src/server/records/record-catalog.server";

test("loadCatalog lists cycles without report content and marks unread by id only", async () => {
  let cycleQuery: { select?: { reports?: { select?: Record<string, unknown> } } } | undefined;
  let unreadQuery: { where?: Record<string, unknown>; select?: Record<string, unknown> } | undefined;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportCycle: {
      findMany: async (query: typeof cycleQuery) => {
        cycleQuery = query;
        return [
          {
            id: "cycle-1",
            year: 2026,
            week: 38,
            title: "2026 W38 工作周报",
            reports: [
              {
                id: "mine-unread",
                kind: "member",
                authorId: "member-a",
                title: "Mine",
                status: "draft",
                sourceTemplateId: "format-1",
                settingsId: null,
                hiddenFromAuthor: false,
                submittedAt: null,
                createdAt: new Date("2026-09-14T05:00:00.000Z"),
                author: {
                  id: "member-a",
                  username: "alice",
                  displayName: "Alice",
                  avatarObjectKey: null,
                },
              },
              {
                id: "peer-heavy",
                kind: "member",
                authorId: "member-b",
                title: "Peer",
                status: "submitted",
                sourceTemplateId: "format-1",
                settingsId: null,
                hiddenFromAuthor: false,
                submittedAt: new Date("2026-09-14T06:00:00.000Z"),
                createdAt: new Date("2026-09-14T06:00:00.000Z"),
                author: {
                  id: "member-b",
                  username: "bob",
                  displayName: "Bob",
                  avatarObjectKey: null,
                },
              },
            ],
          },
        ];
      },
    },
    weeklyReportFavorite: { findMany: async () => [] },
    recordNote: { findMany: async () => [] },
    user: {
      findUnique: async () => ({
        id: "member-a",
        username: "alice",
        displayName: "Alice",
        avatarObjectKey: null,
      }),
    },
    weeklyReportTemplate: {
      findMany: async () => [],
    },
    weeklyReport: {
      findMany: async (query: typeof unreadQuery) => {
        unreadQuery = query;
        return [{ id: "mine-unread" }];
      },
    },
  } as unknown as PrismaClient;

  const catalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "workspace-1",
    userId: "member-a",
  });

  expect(cycleQuery?.select?.reports?.select).toBeDefined();
  expect(cycleQuery?.select?.reports?.select).not.toHaveProperty("content");
  expect(unreadQuery?.select).toEqual({ id: true });
  expect(unreadQuery?.where).toMatchObject({
    workspaceId: "workspace-1",
    authorId: "member-a",
    kind: "member",
    hiddenFromAuthor: false,
  });
  expect(catalog.myReports).toEqual([
    expect.objectContaining({ id: "mine-unread", unread: true }),
  ]);
});

test("loadCatalog hides other leaders' template parents under 成员周报", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportCycle: {
      findMany: async () => [
        {
          id: "cycle-1",
          year: 2026,
          week: 38,
          title: "2026 W38 工作周报",
          reports: [
            {
              id: "leader-a-format",
              kind: "template",
              authorId: "leader-a",
              title: "Format A",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: null,
              createdAt: new Date("2026-09-14T02:00:00.000Z"),
              author: { id: "leader-a", username: "a", displayName: "A" },
            },
            {
              id: "leader-b-format",
              kind: "template",
              authorId: "leader-b",
              title: "Format B",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: null,
              createdAt: new Date("2026-09-14T03:00:00.000Z"),
              author: { id: "leader-b", username: "b", displayName: "B" },
            },
            {
              id: "leader-b-overview",
              kind: "template",
              authorId: "leader-b",
              title: "2026 W38 工作周报",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: null,
              createdAt: new Date("2026-09-14T01:00:00.000Z"),
              author: { id: "leader-b", username: "b", displayName: "B" },
            },
            {
              id: "submission-under-b",
              kind: "member",
              authorId: "member-a",
              title: "Alice 2026 W38 工作周报",
              status: "submitted",
              content: { tabs: { Summary: { markdown: "Done" } } },
              sourceTemplateId: "leader-b-overview",
              createdAt: new Date("2026-09-14T04:00:00.000Z"),
              author: { id: "member-a", username: "alice", displayName: "Alice" },
            },
            {
              id: "mine",
              kind: "member",
              authorId: "leader-b",
              title: "B 2026 W38 工作周报",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } }, assignment: { unread: true } },
              sourceTemplateId: "leader-a-format",
              createdAt: new Date("2026-09-14T05:00:00.000Z"),
              author: { id: "leader-b", username: "b", displayName: "B" },
            },
          ],
        },
      ],
    },
    weeklyReportFavorite: { findMany: async () => [] },
    recordNote: { findMany: async () => [] },
    user: {
      findUnique: async () => ({ id: "leader-b", username: "b", displayName: "B" }),
    },
    weeklyReportTemplate: {
      findMany: async (query: { where?: { ownerId?: string; applied?: boolean } }) => {
        expect(query.where?.ownerId).toBe("leader-b");
        expect(query.where?.applied).toBe(true);
        return [];
      },
    },
    weeklyReport: {
      findMany: async () => [{ id: "mine" }],
    },
  } as unknown as PrismaClient;

  const catalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "workspace-1",
    userId: "leader-b",
  });

  expect(catalog.memberWeeks).toEqual([
    {
      year: 2026,
      week: 38,
      title: "2026 W38 工作周报",
      cycleId: "cycle-1",
      overviewReportId: "leader-b-overview",
      submissions: [
        expect.objectContaining({
          id: "submission-under-b",
          title: "Alice 2026 W38 工作周报",
          author: expect.objectContaining({ displayName: "Alice" }),
        }),
      ],
    },
  ]);
  expect(catalog.formatChips).toEqual([
    expect.objectContaining({
      id: null,
      interactive: false,
      sendArmed: false,
    }),
  ]);
  expect(catalog.myReports.map((row) => row.id)).toEqual(["mine"]);
});

test("loadCatalog creates a personal format when send settings are applied", async () => {
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportCycle: {
      findMany: async () => [],
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
      create: async () => {
        throw new Error("cycle should already exist");
      },
    },
    weeklyReportFavorite: { findMany: async () => [] },
    recordNote: { findMany: async () => [] },
    user: {
      findUnique: async () => ({ id: "leader-b", username: "b", displayName: "B" }),
    },
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-b",
          name: "算法汇报",
          sendWeekday: 5,
          sendTime: "15:00",
          scheduleEnabled: false,
          dimensions: [],
        },
      ],
    },
    weeklyReport: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async (query: { data: Record<string, unknown> }) => {
        created.push(query.data);
        return { id: "format-new" };
      },
      update: async (query: { data: Record<string, unknown> }) => {
        updates.push(query.data);
        return {};
      },
    },
  } as unknown as PrismaClient;

  const catalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "workspace-1",
    userId: "leader-b",
  });

  expect(catalog.formatChips).toEqual([
    expect.objectContaining({
      id: "format-new",
      settingsId: "settings-b",
      name: "算法汇报",
      interactive: true,
    }),
  ]);
  expect(created[0]).toMatchObject({
    kind: "template",
    authorId: "leader-b",
    settingsId: "settings-b",
    title: "算法汇报",
  });
});

test("loadCatalog exposes one chip per applied settings stream", async () => {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportCycle: {
      findMany: async () => [
        {
          id: "cycle-1",
          year: 2026,
          week: 38,
          title: "2026 W38 工作周报",
          reports: [
            {
              id: "overview-algo",
              kind: "template",
              authorId: "leader-b",
              title: "2026 W38 工作周报",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: null,
              settingsId: "settings-algo",
              createdAt: new Date("2026-09-14T01:00:00.000Z"),
              author: { id: "leader-b", username: "b", displayName: "B" },
            },
            {
              id: "assignment-algo",
              kind: "member",
              authorId: "member-a",
              title: "Alice 2026 W38 工作周报",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: "overview-algo",
              settingsId: null,
              createdAt: new Date("2026-09-14T02:00:00.000Z"),
              author: { id: "member-a", username: "alice", displayName: "Alice" },
            },
          ],
        },
      ],
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
    },
    weeklyReportFavorite: { findMany: async () => [] },
    recordNote: { findMany: async () => [] },
    user: {
      findUnique: async () => ({ id: "leader-b", username: "b", displayName: "B" }),
    },
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-algo",
          name: "算法汇报",
          sendWeekday: 5,
          sendTime: "15:00",
          scheduleEnabled: false,
          dimensions: [],
        },
        {
          id: "settings-product",
          name: "产品汇报",
          sendWeekday: 5,
          sendTime: "15:00",
          scheduleEnabled: false,
          dimensions: [],
        },
      ],
    },
    weeklyReport: {
      findMany: async () => [],
      findFirst: async (query: { where?: { settingsId?: string | null } }) => {
        if (query.where?.settingsId === "settings-algo") return { id: "format-algo" };
        return null;
      },
      create: async (query: { data: Record<string, unknown> }) => {
        created.push(query.data);
        return { id: "format-product" };
      },
      update: async () => ({}),
    },
  } as unknown as PrismaClient;

  // The fixture seeds 2026 W38 and expects that week's alreadySent state; pin `now` to W38
  // (mid-week, noon UTC) so the test is deterministic instead of breaking every week rollover.
  const catalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "workspace-1",
    userId: "leader-b",
    now: new Date("2026-09-17T12:00:00.000Z"),
  });

  expect(catalog.formatChips).toEqual([
    expect.objectContaining({
      id: "format-algo",
      settingsId: "settings-algo",
      name: "算法汇报",
      alreadySent: true,
      interactive: true,
    }),
    expect.objectContaining({
      id: "format-product",
      settingsId: "settings-product",
      name: "产品汇报",
      alreadySent: false,
      interactive: true,
    }),
  ]);
  expect(created[0]).toMatchObject({
    settingsId: "settings-product",
    title: "产品汇报",
  });
});
