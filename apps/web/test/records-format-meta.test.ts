import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { updateFormatReportMeta } from "#src/server/records/record-catalog-format.server";

test("updateFormatReportMeta renames the live format without rebinding its ISO week", async () => {
  const reportUpdates: Array<Record<string, unknown>> = [];
  const settingsUpdates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "format-1",
        authorId: "leader",
        kind: "template",
        title: "LRM周报",
        settingsId: "settings-1",
        cycleId: "cycle-38",
        updatedAt: new Date("2026-09-18T04:00:00.000Z"),
        cycle: { id: "cycle-38", year: 2026, week: 38 },
        submissions: [],
      }),
      update: async (query: { data: Record<string, unknown> }) => {
        reportUpdates.push(query.data);
        return { id: "format-1", updatedAt: new Date("2026-09-18T05:00:00.000Z") };
      },
    },
    weeklyReportTemplate: {
      update: async (query: { data: Record<string, unknown> }) => {
        settingsUpdates.push(query.data);
        return { id: "settings-1" };
      },
    },
  } as unknown as PrismaClient;

  const result = await updateFormatReportMeta(db, {
    workspaceId: "workspace-1",
    userId: "leader",
    reportId: "format-1",
    title: "产品周报",
  });

  expect(result).toEqual({
    id: "format-1",
    title: "产品周报",
    year: 2026,
    week: 38,
    updatedAt: "2026-09-18T05:00:00.000Z",
  });
  expect(reportUpdates[0]).toEqual({ title: "产品周报" });
  expect(settingsUpdates[0]).toMatchObject({ name: "产品周报" });
});

test("updateFormatReportMeta rejects overview templates and blank titles", async () => {
  const overviewDb = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "overview-1",
        authorId: "leader",
        kind: "template",
        title: "2026 W38 工作周报",
        settingsId: "settings-1",
        cycleId: "cycle-38",
        cycle: { id: "cycle-38", year: 2026, week: 38 },
        submissions: [{ id: "member-1" }],
      }),
    },
  } as unknown as PrismaClient;

  await expect(
    updateFormatReportMeta(overviewDb, {
      workspaceId: "workspace-1",
      userId: "leader",
      reportId: "overview-1",
      title: "新产品",
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

  const formatDb = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "format-1",
        authorId: "leader",
        kind: "template",
        title: "LRM周报",
        settingsId: "settings-1",
        cycleId: "cycle-38",
        cycle: { id: "cycle-38", year: 2026, week: 38 },
        submissions: [],
      }),
    },
  } as unknown as PrismaClient;

  await expect(
    updateFormatReportMeta(formatDb, {
      workspaceId: "workspace-1",
      userId: "leader",
      reportId: "format-1",
      title: "   ",
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});
