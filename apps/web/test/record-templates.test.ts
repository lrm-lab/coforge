import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { recordTemplates } from "#src/server/records/record-catalog-templates.server";

test("applyTemplate toggles off and allows zero applied rows", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        name: "算法汇报",
        applied: true,
        dimensions: [],
      }),
      update: async (query: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(query);
        return {};
      },
    },
  } as unknown as PrismaClient;

  const result = await recordTemplates(db).applyTemplate({
    workspaceId: "workspace-1",
    userId: "leader",
    templateId: "settings-1",
  });

  expect(result).toEqual({ id: "settings-1", active: false });
  expect(updates).toEqual([
    { where: { id: "settings-1" }, data: { applied: false, scheduleEnabled: false } },
  ]);
});

test("applyTemplate activates one stream without clearing other applied rows", async () => {
  const ops: string[] = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-2",
        name: "产品汇报",
        applied: false,
        dimensions: [],
      }),
      updateMany: async () => {
        ops.push("updateMany");
        return { count: 1 };
      },
      update: async (query: { where: object; data: object }) => {
        ops.push(`update:${JSON.stringify(query)}`);
        return {};
      },
    },
    weeklyReport: {
      findFirst: async () => ({ id: "existing-format" }),
      update: async (query: { where: object; data: object }) => {
        ops.push(`update:${JSON.stringify(query)}`);
        return {};
      },
    },
  } as unknown as PrismaClient;

  const result = await recordTemplates(db).applyTemplate({
    workspaceId: "workspace-1",
    userId: "leader",
    templateId: "settings-2",
  });

  expect(result).toEqual({ id: "settings-2", active: true });
  expect(ops).toEqual([
    'update:{"where":{"id":"settings-2"},"data":{"applied":true,"scheduleEnabled":true}}',
    'update:{"where":{"id":"existing-format"},"data":{"title":"产品汇报"}}',
  ]);
  expect(ops).not.toContain("updateMany");
});

test("createTemplate with scheduleEnabled writes applied and ensures a format", async () => {
  const createdTemplates: Array<Record<string, unknown>> = [];
  const createdReports: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      count: async () => 0,
    },
    weeklyReportTemplate: {
      create: async (query: { data: Record<string, unknown> }) => {
        createdTemplates.push(query.data);
        return { id: "settings-new", name: query.data.name, dimensions: query.data.dimensions };
      },
    },
    weeklyReport: {
      findFirst: async () => null,
      create: async (query: { data: Record<string, unknown> }) => {
        createdReports.push(query.data);
        return { id: "format-new" };
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
  } as unknown as PrismaClient;
  db.$transaction = (async (callback: (tx: PrismaClient) => Promise<unknown>) =>
    callback(db)) as unknown as typeof db.$transaction;

  const result = await recordTemplates(db).createTemplate({
    workspaceId: "workspace-1",
    userId: "leader-b",
    name: "算法汇报",
    frequency: "weekly",
    sendTime: "15:00",
    sendWeekday: 5,
    scheduleEnabled: true,
    sections: [{ title: "Summary", children: ["Current Works"] }],
    allMembers: true,
    recipientUserIds: [],
  });

  expect(result).toEqual({ id: "settings-new" });
  expect(createdTemplates[0]).toMatchObject({
    applied: true,
    scheduleEnabled: true,
    name: "算法汇报",
  });
  expect(createdReports[0]).toMatchObject({
    kind: "template",
    settingsId: "settings-new",
    authorId: "leader-b",
  });
});

test("createTemplate allows a regular Workspace member during MVP rollout", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportTemplate: {
      create: async () => ({ id: "member-settings" }),
    },
  } as unknown as PrismaClient;
  db.$transaction = (async (callback: (tx: PrismaClient) => Promise<unknown>) =>
    callback(db)) as unknown as typeof db.$transaction;

  await expect(
    recordTemplates(db).createTemplate({
      workspaceId: "workspace-1",
      userId: "member-a",
      name: "算法汇报",
      frequency: "weekly",
      sendTime: "15:00",
      sendWeekday: 5,
      scheduleEnabled: false,
      sections: [{ title: "Summary", children: [] }],
      allMembers: true,
      recipientUserIds: [],
    }),
  ).resolves.toEqual({ id: "member-settings" });
});

test("createTemplate with scheduleEnabled false stays inactive", async () => {
  const createdTemplates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportTemplate: {
      create: async (query: { data: Record<string, unknown> }) => {
        createdTemplates.push(query.data);
        return { id: "settings-off" };
      },
    },
    weeklyReport: {
      create: async () => {
        throw new Error("should not ensure format");
      },
    },
  } as unknown as PrismaClient;
  db.$transaction = (async (callback: (tx: PrismaClient) => Promise<unknown>) =>
    callback(db)) as unknown as typeof db.$transaction;

  await recordTemplates(db).createTemplate({
    workspaceId: "workspace-1",
    userId: "leader-b",
    name: "算法汇报",
    frequency: "weekly",
    sendTime: "12:00",
    sendWeekday: 5,
    scheduleEnabled: false,
    sections: [{ title: "Summary", children: [] }],
    allMembers: true,
    recipientUserIds: [],
  });

  expect(createdTemplates[0]).toMatchObject({
    applied: false,
    scheduleEnabled: false,
  });
});

test("updateTemplate syncs applied with scheduleEnabled and ensures format when enabling", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const createdReports: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      count: async () => 0,
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        applied: false,
        name: "旧名",
      }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        weeklyReportTemplateRecipient: {
          deleteMany: async () => ({ count: 0 }),
        },
        weeklyReportTemplate: {
          update: async (query: { data: Record<string, unknown> }) => {
            updates.push(query.data);
            return {};
          },
        },
      };
      return fn(tx);
    },
    weeklyReport: {
      findFirst: async () => null,
      create: async (query: { data: Record<string, unknown> }) => {
        createdReports.push(query.data);
        return { id: "format-from-update" };
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
  } as unknown as PrismaClient;

  await recordTemplates(db).updateTemplate({
    workspaceId: "workspace-1",
    userId: "leader-b",
    templateId: "settings-1",
    name: "算法汇报",
    frequency: "weekly",
    sendTime: "15:00",
    sendWeekday: 5,
    scheduleEnabled: true,
    sections: [{ title: "Summary", children: [] }],
    allMembers: true,
    recipientUserIds: [],
  });

  expect(updates[0]).toMatchObject({
    applied: true,
    scheduleEnabled: true,
    name: "算法汇报",
  });
  expect(createdReports[0]).toMatchObject({
    settingsId: "settings-1",
    kind: "template",
  });
});
