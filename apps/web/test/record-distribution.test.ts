import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { recordDistribution } from "#src/server/records/record-distribution.server";

/** Minimal transactional Prisma adapter for distribution tests; concurrency is tested on PostgreSQL. */
function distributionDatabase(db: PrismaClient): PrismaClient {
  const findFirst = db.weeklyReport.findFirst.bind(db.weeklyReport);
  db.weeklyReport.findFirst = (async (query: { select?: { submissions?: unknown } }) =>
    query.select?.submissions
      ? null
      : findFirst(query as never)) as unknown as typeof db.weeklyReport.findFirst;
  db.weeklyReportCycle.upsert = (async () =>
    db.weeklyReportCycle.findUnique({} as never)) as unknown as typeof db.weeklyReportCycle.upsert;
  db.weeklyReport.createManyAndReturn = (async (query: { data: Array<{ authorId: string }> }) => {
    await db.weeklyReport.createMany(query as never);
    return query.data.map((row, index) => ({ id: `assignment-${index}`, authorId: row.authorId }));
  }) as unknown as typeof db.weeklyReport.createManyAndReturn;
  db.$queryRaw = (async () => []) as unknown as typeof db.$queryRaw;
  db.$transaction = (async (callback: (tx: PrismaClient) => Promise<unknown>) =>
    callback(db)) as unknown as typeof db.$transaction;
  return db;
}

test("sendWeeklyAssignments creates a new parent and unread assignments for recipients", async () => {
  const created: Array<Record<string, unknown>> = [];
  let createManyCalls = 0;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      findMany: async () => [{ userId: "leader" }, { userId: "member-a" }, { userId: "member-b" }],
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "source-1",
        settingsId: "settings-1",
        content: { tabs: { Summary: { markdown: "# Outline" } } },
      }),
      update: async () => ({}),
      create: async (query: { data: Record<string, unknown> }) => {
        created.push(query.data);
        return {
          id: `created-${created.length}`,
          title: query.data.title,
        };
      },
      createMany: async (query: { data: Array<Record<string, unknown>> }) => {
        createManyCalls += 1;
        created.push(...query.data);
        return { count: query.data.length };
      },
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
    },
    weeklyReportTemplate: {
      findFirst: async (query: { where?: { applied?: boolean; id?: string } }) => {
        if (query.where?.applied === false) return null;
        expect(query.where?.id).toBe("settings-1");
        return {
          id: "settings-1",
          allMembers: false,
          recipients: [{ userId: "member-a" }, { userId: "leader" }],
        };
      },
    },
    user: {
      findMany: async () => [
        { id: "member-a", displayName: "Alice", username: "alice" },
        { id: "leader", displayName: "Boss", username: "boss" },
      ],
    },
  } as unknown as PrismaClient;

  const result = await recordDistribution(distributionDatabase(db)).sendWeeklyAssignments({
    workspaceId: "workspace-1",
    userId: "leader",
    sourceReportId: "source-1",
    content: { tabs: { Summary: { markdown: "# Outline" } } },
    now: new Date("2026-09-14T12:00:00+08:00"),
  });

  expect(result).toMatchObject({
    parentId: "created-1",
    title: "2026 W38 工作周报",
    year: 2026,
    week: 38,
    assignmentCount: 2,
  });
  expect(created).toHaveLength(3);
  expect(createManyCalls).toBe(1);
  expect(created[0]).toMatchObject({
    kind: "template",
    authorId: "leader",
    settingsId: "settings-1",
    title: "2026 W38 工作周报",
  });
  expect(created[1]).toMatchObject({
    kind: "member",
    authorId: "member-a",
    sourceTemplateId: "created-1",
    title: "Alice 2026 W38 工作周报",
  });
  expect(created[2]).toMatchObject({
    kind: "member",
    authorId: "leader",
    sourceTemplateId: "created-1",
    title: "Boss 2026 W38 工作周报",
    status: "draft",
    content: {
      tabs: { Summary: { markdown: "# Outline" } },
      assignment: { unread: true },
    },
  });
});

test("sendWeeklyAssignments does not post a #general notice", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      findMany: async () => [{ userId: "leader" }, { userId: "member-a" }],
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "source-1",
        settingsId: "settings-1",
        content: { tabs: { Summary: { markdown: "# Outline" } } },
      }),
      update: async () => ({}),
      create: async (query: { data: Record<string, unknown> }) => ({
        id: query.data.kind === "template" ? "parent-1" : "child-1",
        title: query.data.title,
      }),
      createMany: async (query: { data: Array<Record<string, unknown>> }) => ({
        count: query.data.length,
      }),
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        allMembers: false,
        recipients: [{ userId: "member-a" }],
      }),
    },
    user: {
      findMany: async () => [{ id: "member-a", displayName: "Alice", username: "alice" }],
    },
    conversation: {
      findFirst: async () => {
        throw new Error("weekly send must not look up a public channel");
      },
    },
  } as unknown as PrismaClient;

  const result = await recordDistribution(distributionDatabase(db)).sendWeeklyAssignments({
    workspaceId: "workspace-1",
    userId: "leader",
    sourceReportId: "source-1",
    now: new Date("2026-09-14T12:00:00+08:00"),
  });

  expect(result).toMatchObject({ parentId: "parent-1", assignmentCount: 1, week: 38 });
});

test("sendWeeklyAssignments rejects when no send settings are applied", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "source-1",
        settingsId: "settings-1",
        content: { tabs: { Summary: { markdown: "# Outline" } } },
      }),
      update: async () => ({}),
      create: async () => {
        throw new Error("should not create reports without applied settings");
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;

  await expect(
    recordDistribution(db).sendWeeklyAssignments({
      workspaceId: "workspace-1",
      userId: "leader",
      sourceReportId: "source-1",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
});

test("sendWeeklyAssignments rejects when the format has no settings stream", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "source-1",
        settingsId: null,
        content: { tabs: { Summary: { markdown: "# Outline" } } },
      }),
    },
  } as unknown as PrismaClient;

  await expect(
    recordDistribution(db).sendWeeklyAssignments({
      workspaceId: "workspace-1",
      userId: "leader",
      sourceReportId: "source-1",
    }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("runDueScheduledWeeklyAssignments skips when not due", async () => {
  const db = {
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
          sendTime: "15:00",
          sendWeekday: 5,
        },
      ],
    },
  } as unknown as PrismaClient;

  // Thursday 15:00 Asia/Shanghai
  const result = await recordDistribution(db).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-17T07:00:00.000Z"),
  });

  expect(result.sent).toBe(0);
  expect(result.results).toEqual([
    {
      workspaceId: "workspace-1",
      templateId: "settings-1",
      status: "skipped",
      reason: "not-due",
    },
  ]);
});

test("runDueScheduledWeeklyAssignments skips when the ISO week already has assignments", async () => {
  const db = {
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
          sendTime: "15:00",
          sendWeekday: 5,
        },
      ],
    },
    weeklyReport: {
      findMany: async () => [],
      findFirst: async (query: {
        where?: { settingsId?: string; submissions?: { some?: unknown } };
      }) => {
        expect(query.where?.settingsId).toBe("settings-1");
        expect(query.where?.submissions?.some).toBeTruthy();
        return { id: "already-parent" };
      },
    },
  } as unknown as PrismaClient;

  const result = await recordDistribution(db).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-18T07:30:00.000Z"),
  });

  expect(result.sent).toBe(0);
  expect(result.results[0]).toMatchObject({
    status: "skipped",
    reason: "already-sent",
  });
});

test("runDueScheduledWeeklyAssignments sends when due and not yet sent", async () => {
  let sendCalls = 0;
  const created: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner", userId: "leader" }),
      findMany: async () => [{ userId: "leader" }, { userId: "member-a" }],
    },
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
          sendTime: "15:00",
          sendWeekday: 5,
        },
      ],
      findFirst: async () => ({
        id: "settings-1",
        allMembers: false,
        recipients: [{ userId: "member-a" }],
      }),
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: {
          id?: string;
          settingsId?: string;
          submissions?: { some?: unknown; none?: unknown };
        };
      }) => {
        if (query.where?.submissions?.some) return null;
        return {
          id: "source-1",
          authorId: "leader",
          settingsId: "settings-1",
          content: { tabs: { Summary: { markdown: "# Outline" } } },
        };
      },
      update: async () => ({}),
      create: async (query: { data: Record<string, unknown> }) => {
        sendCalls += 1;
        created.push(query.data);
        return {
          id: query.data.kind === "template" ? "parent-1" : `child-${created.length}`,
          title: query.data.title,
        };
      },
      createMany: async (query: { data: Array<Record<string, unknown>> }) => {
        sendCalls += 1;
        created.push(...query.data);
        return { count: query.data.length };
      },
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
    },
    user: {
      findMany: async () => [{ id: "member-a", displayName: "Alice", username: "alice" }],
      findUnique: async () => ({ displayName: "Boss", username: "boss" }),
    },
  } as unknown as PrismaClient;

  const result = await recordDistribution(distributionDatabase(db), {
    notify: async () => ({ status: "notified" }),
  }).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-18T07:30:00.000Z"),
  });

  expect(result.sent).toBe(1);
  expect(result.results[0]).toMatchObject({
    status: "sent",
    parentId: "parent-1",
    assignmentCount: 1,
  });
  expect(created[0]).toMatchObject({
    kind: "template",
    settingsId: "settings-1",
  });
  expect(sendCalls).toBeGreaterThan(0);
});

test("runDueScheduledWeeklyAssignments creates the format on the schedule-timezone week", async () => {
  const cycleCreates: Array<Record<string, unknown>> = [];
  let rowSeq = 0;
  let formatRow: { id: string; settingsId: string; content: unknown } | null = null;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner", userId: "leader" }),
      findMany: async () => [{ userId: "leader" }, { userId: "member-a" }],
    },
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
          sendTime: "00:00",
          sendWeekday: 7,
        },
      ],
      findFirst: async () => ({
        id: "settings-1",
        name: "算法汇报",
        allMembers: false,
        recipients: [{ userId: "member-a" }],
      }),
    },
    weeklyReport: {
      findFirst: async (query: { where?: Record<string, unknown> }) => {
        const where = query.where ?? {};
        const submissions = where.submissions as { some?: unknown; none?: unknown } | undefined;
        if (submissions?.some || submissions?.none) return null;
        if (where.id === formatRow?.id) return formatRow;
        return null;
      },
      update: async () => ({}),
      create: async (query: { data: Record<string, unknown> }) => {
        rowSeq += 1;
        const id = `row-${rowSeq}`;
        if (!formatRow && query.data.settingsId) {
          formatRow = {
            id,
            settingsId: query.data.settingsId as string,
            content: query.data.content,
          };
        }
        return { id, title: query.data.title };
      },
      createMany: async (query: { data: Array<Record<string, unknown>> }) => ({
        count: query.data.length,
      }),
    },
    weeklyReportCycle: {
      findUnique: async (query: { where?: { workspaceId_year_week?: unknown } }) =>
        query.where?.workspaceId_year_week
          ? null
          : { id: "cycle-dist", year: 2026, week: 45, title: "2026 W45 工作周报" },
      create: async (query: { data: Record<string, unknown> }) => {
        cycleCreates.push(query.data);
        return {
          id: "cycle-new",
          year: query.data.year,
          week: query.data.week,
          title: query.data.title,
        };
      },
    },
    user: {
      findMany: async () => [{ id: "member-a", displayName: "Alice", username: "alice" }],
      findUnique: async () => ({ displayName: "Boss", username: "boss" }),
    },
  } as unknown as PrismaClient;

  // 2026-11-07T20:00Z is Saturday in America/New_York but already Sunday
  // 2026-11-08 04:00 in Asia/Shanghai (ISO week 45). The cron path once passed
  // a pre-zoned calendar date into ensureFormatForSettings, which re-zoned it
  // to Monday's week 46 on hosts west of UTC+4 — the format landed on a cycle
  // the send never targets.
  const previousTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const result = await recordDistribution(distributionDatabase(db), {
      notify: async () => ({ status: "notified" }),
    }).runDueScheduledWeeklyAssignments({
      now: new Date("2026-11-07T20:00:00.000Z"),
    });

    expect(result.results[0]).toMatchObject({ status: "sent", assignmentCount: 1 });
    expect(cycleCreates).toHaveLength(1);
    expect(cycleCreates[0]).toMatchObject({ year: 2026, week: 45 });
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test("runDueScheduledWeeklyAssignments skips when Leader edited the format this week", async () => {
  const db = {
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
          sendTime: "15:00",
          sendWeekday: 5,
        },
      ],
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: { submissions?: { some?: unknown; none?: unknown } };
      }) => {
        if (query.where?.submissions?.some) return null;
        return {
          id: "format-1",
          content: {
            tabs: { Summary: { markdown: "edited" } },
            schedule: { cancelledYear: 2026, cancelledWeek: 38 },
          },
        };
      },
    },
  } as unknown as PrismaClient;

  const result = await recordDistribution(db).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-18T07:30:00.000Z"),
  });

  expect(result.sent).toBe(0);
  expect(result.results[0]).toMatchObject({
    status: "skipped",
    reason: "auto-send-cancelled",
  });
});

test("sendWeeklyAssignments rejects sending another leader's format", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => null,
      create: async () => {
        throw new Error("should not create");
      },
    },
  } as unknown as PrismaClient;

  await expect(
    recordDistribution(db).sendWeeklyAssignments({
      workspaceId: "workspace-1",
      userId: "leader-b",
      sourceReportId: "leader-a-format",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
