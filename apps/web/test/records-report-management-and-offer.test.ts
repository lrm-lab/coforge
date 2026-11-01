import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { recordReportManagement } from "#src/server/records/record-report-management.server";
import { recordAssistantOffer } from "#src/server/records/record-assistant-offer.server";
import { recordReportContent } from "#src/server/records/record-report-content.server";

test("setReportFavorite adds and removes a favorite for an accessible member report", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "assignment-1",
        kind: "member",
        authorId: "member-a",
        sourceTemplate: { authorId: "leader" },
      }),
    },
    weeklyReportFavorite: {
      upsert: async (query: { where: unknown; create: Record<string, unknown> }) => {
        creates.push(query.create);
        return query.create;
      },
      deleteMany: async (query: { where: Record<string, unknown> }) => {
        deletes.push(query.where);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  await expect(
    recordReportManagement(db).setReportFavorite({
      workspaceId: "workspace-1",
      userId: "leader",
      reportId: "assignment-1",
      favorited: true,
    }),
  ).resolves.toEqual({ favorited: true });
  expect(creates).toEqual([{ userId: "leader", reportId: "assignment-1" }]);

  await expect(
    recordReportManagement(db).setReportFavorite({
      workspaceId: "workspace-1",
      userId: "leader",
      reportId: "assignment-1",
      favorited: false,
    }),
  ).resolves.toEqual({ favorited: false });
  expect(deletes).toEqual([{ userId: "leader", reportId: "assignment-1" }]);
});

test("setReportFavorite rejects reports the viewer cannot open", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "assignment-1",
        kind: "member",
        authorId: "member-a",
        sourceTemplate: { authorId: "leader" },
      }),
    },
    weeklyReportFavorite: {
      findUnique: async () => null,
      upsert: async () => {
        throw new Error("should not upsert");
      },
    },
  } as unknown as PrismaClient;

  await expect(
    recordReportManagement(db).setReportFavorite({
      workspaceId: "workspace-1",
      userId: "outsider",
      reportId: "assignment-1",
      favorited: true,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("saveReportContent with askToSend cancels auto-send and leaves offer-send to the open session", async () => {
  const comments: Array<Record<string, unknown>> = [];
  const contentUpdates: Array<Record<string, unknown>> = [];
  const formatRow = {
    id: "format-1",
    authorId: "leader",
    kind: "template",
    settingsId: "settings-1",
    content: { tabs: { Summary: { markdown: "old" } } },
    cycle: { year: 2026, week: 38 },
    submissions: [],
    updatedAt: new Date("2026-09-18T06:00:00.000Z"),
    author: { displayName: "Mark", username: "mark" },
  };
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      findMany: async () => [],
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: {
          id?: string;
          settingsId?: string;
          submissions?: { some?: unknown; none?: unknown };
        };
        select?: Record<string, unknown>;
      }) => {
        if (query.where?.submissions?.some) return null;
        if (query.where?.submissions?.none) return { id: "format-1" };
        if (query.where?.id === "format-1" || query.where?.settingsId) {
          return formatRow;
        }
        return null;
      },
      update: async (query: { data: Record<string, unknown> }) => {
        contentUpdates.push(query.data);
        return {
          id: "format-1",
          status: "draft",
          updatedAt: new Date("2026-09-18T04:00:00.000Z"),
        };
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        sendWeekday: 5,
        sendTime: "15:00",
        scheduleEnabled: true,
        applied: true,
        allMembers: false,
        recipients: [
          {
            user: {
              id: "m1",
              displayName: "Ada",
              username: "ada",
              avatarObjectKey: null,
            },
          },
        ],
      }),
      update: async () => ({}),
    },
    recordComment: {
      create: async (query: { data: Record<string, unknown> }) => {
        comments.push(query.data);
        return { id: `c-${comments.length}` };
      },
    },
  } as unknown as PrismaClient;

  const result = await recordReportContent(db).saveReportContent({
    workspaceId: "workspace-1",
    userId: "leader",
    reportId: "format-1",
    content: { tabs: { Summary: { markdown: "new body" } } },
    askToSend: true,
    // Friday 14:30 Shanghai = inside preview hour for 15:00 send
    now: new Date("2026-09-18T06:30:00.000Z"),
  });

  expect(result.assistantPosted).toBe(true);
  expect(result.autoSendJustCancelled).toBe(true);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({
    authorType: "assistant",
    body: "已取消本周自动发送。保存后请手动发送周报模板。",
  });
  expect(
    (contentUpdates[0]?.content as { schedule?: { cancelledWeek?: number } })?.schedule
      ?.cancelledWeek,
  ).toBe(38);
});

test("ensureAssistantIntro posts the offer-send for the current ISO week when the live format cycle is stale", async () => {
  const comments: Array<Record<string, unknown>> = [];
  const reportUpdates: Array<Record<string, unknown>> = [];
  const formatRow = {
    id: "format-1",
    authorId: "leader",
    kind: "template",
    settingsId: "settings-1",
    content: { tabs: { Summary: { markdown: "old" } } },
    // Created last week; the calendar has advanced to W39 by now.
    cycle: { id: "cycle-38", year: 2026, week: 38 },
    submissions: [],
    updatedAt: new Date("2026-09-18T06:00:00.000Z"),
    author: { displayName: "李健", username: "lijian" },
  };
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      findMany: async () => [],
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-39",
        year: 2026,
        week: 39,
        title: "2026 W39",
      }),
      create: async () => {
        throw new Error("current week cycle must already exist");
      },
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: {
          id?: string;
          settingsId?: string;
          submissions?: { some?: unknown; none?: unknown };
          cycle?: { year?: number; week?: number };
        };
        select?: Record<string, unknown>;
      }) => {
        if (query.where?.submissions?.some) return null;
        if (query.where?.submissions?.none) return { id: "format-1" };
        if (query.where?.id === "format-1" || query.where?.settingsId) {
          return formatRow;
        }
        return null;
      },
      update: async (query: { data: Record<string, unknown> }) => {
        reportUpdates.push(query.data);
        if (typeof query.data.cycleId === "string") {
          formatRow.cycle = { id: query.data.cycleId, year: 2026, week: 39 };
        }
        return {
          id: "format-1",
          updatedAt: new Date("2026-09-24T06:40:00.000Z"),
        };
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        sendWeekday: 4,
        sendTime: "15:00",
        scheduleEnabled: true,
        applied: true,
        allMembers: false,
        recipients: [
          {
            user: {
              id: "m1",
              displayName: "Ada",
              username: "ada",
              avatarObjectKey: null,
            },
          },
        ],
      }),
    },
    recordComment: {
      findMany: async () => [],
      create: async (query: { data: Record<string, unknown> }) => {
        comments.push(query.data);
        return { id: `c-${comments.length}` };
      },
    },
  } as unknown as PrismaClient;

  await recordAssistantOffer(db).ensureAssistantIntro({
    workspaceId: "workspace-1",
    userId: "leader",
    subjectType: "report",
    subjectId: "format-1",
    assistantSessionId: "session-1",
    surface: "format",
    // Thursday 14:40 Shanghai = inside the 14:00–15:00 preview hour for Thursday 15:00
    now: new Date("2026-09-24T06:40:00.000Z"),
  });

  expect(comments.at(-1)).toMatchObject({
    authorType: "assistant",
    body: "hi，李健，2026 W39的工作周报模板已生成，请确认是否发送。",
    payload: {
      kind: "offer-send",
      year: 2026,
      week: 39,
      weekTitle: "2026 W39 (09.21-09.25)",
    },
  });
  // The stale live format was rebound onto the current week's cycle.
  expect(reportUpdates.some((row) => row.cycleId === "cycle-39")).toBe(true);
});

test("ensureAssistantIntro appends this week's offer-send and leaves an older card in the thread", async () => {
  const stored: Array<Record<string, unknown>> = [
    {
      id: "c-w38",
      authorType: "assistant",
      body: "hi，李健，2026 W38的工作周报模板已生成，请确认是否发送。",
      payload: {
        kind: "offer-send",
        year: 2026,
        week: 38,
        weekTitle: "2026 W38 (09.14-09.18)",
      },
      createdAt: new Date("2026-09-18T01:33:13.000Z"),
      assistantSessionId: "session-1",
      authorUser: null,
    },
  ];
  const formatRow = {
    id: "format-1",
    authorId: "leader",
    kind: "template",
    settingsId: "settings-1",
    content: { tabs: { Summary: { markdown: "old" } } },
    cycle: { id: "cycle-38", year: 2026, week: 38 },
    submissions: [],
    updatedAt: new Date("2026-09-18T06:00:00.000Z"),
    author: { displayName: "李健", username: "lijian" },
  };
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      findMany: async () => [],
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-39",
        year: 2026,
        week: 39,
        title: "2026 W39",
      }),
      create: async () => {
        throw new Error("current week cycle must already exist");
      },
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
        if (query.where?.submissions?.none) return { id: "format-1" };
        if (query.where?.id === "format-1" || query.where?.settingsId) return formatRow;
        return null;
      },
      update: async (query: { data: { cycleId?: string } }) => {
        if (typeof query.data.cycleId === "string") {
          formatRow.cycle = { id: query.data.cycleId, year: 2026, week: 39 };
        }
        return { id: "format-1", updatedAt: new Date("2026-09-24T06:40:00.000Z") };
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        sendWeekday: 4,
        sendTime: "15:00",
        scheduleEnabled: true,
        applied: true,
        allMembers: false,
        recipients: [
          {
            user: {
              id: "m1",
              displayName: "Ada",
              username: "ada",
              avatarObjectKey: null,
            },
          },
        ],
      }),
    },
    recordComment: {
      findMany: async (query: {
        select?: { payload?: boolean };
        where?: { assistantSessionId?: string };
      }) => {
        const sessionId = query.where?.assistantSessionId;
        const rows = stored.filter((row) => !sessionId || row.assistantSessionId === sessionId);
        if (query.select?.payload) return rows.map((row) => ({ payload: row.payload }));
        return rows;
      },
      create: async (query: { data: Record<string, unknown> }) => {
        const row = {
          id: `c-${stored.length}`,
          authorType: query.data.authorType,
          body: query.data.body,
          payload: query.data.payload ?? null,
          createdAt: new Date("2026-09-24T06:40:01.000Z"),
          assistantSessionId: query.data.assistantSessionId,
          authorUser: null,
        };
        stored.push(row);
        return row;
      },
      update: async () => {
        throw new Error("historical offer-send must not be rewritten");
      },
    },
  } as unknown as PrismaClient;

  const intro = {
    workspaceId: "workspace-1",
    userId: "leader",
    subjectType: "report" as const,
    subjectId: "format-1",
    assistantSessionId: "session-1",
    surface: "format" as const,
    now: new Date("2026-09-24T06:40:00.000Z"),
  };
  const first = await recordAssistantOffer(db).ensureAssistantIntro(intro);
  expect(first.map((row) => row.body)).toEqual([
    "hi，李健，2026 W38的工作周报模板已生成，请确认是否发送。",
    "hi，李健，2026 W39的工作周报模板已生成，请确认是否发送。",
  ]);
  expect(first[0]?.payload).toMatchObject({
    kind: "offer-send",
    year: 2026,
    week: 38,
    weekTitle: "2026 W38 (09.14-09.18)",
  });
  expect(first[1]?.payload).toMatchObject({
    kind: "offer-send",
    year: 2026,
    week: 39,
    weekTitle: "2026 W39 (09.21-09.25)",
  });

  const second = await recordAssistantOffer(db).ensureAssistantIntro(intro);
  expect(second).toHaveLength(2);
});
