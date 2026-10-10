import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  reportContentForAuthor,
  reportContentForRecipient,
  type ReportContent,
} from "#src/features/records/records-content";
import { RecordCatalog } from "#src/server/records/record-catalog.server";

test("applyConfirmedReportBody writes only after the author confirms a suggestion", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "11111111-1111-1111-1111-111111111111",
        authorId: "user-1",
        kind: "member",
        settingsId: null,
        content: { tabs: { Progress: { markdown: "- old\n" } } },
        cycle: { year: 2026, week: 38 },
        submissions: [],
      }),
      update: async (query: { data: Record<string, unknown> }) => {
        updates.push(query.data);
        return {
          id: "11111111-1111-1111-1111-111111111111",
          status: "draft",
          updatedAt: new Date("2026-09-16T12:00:00.000Z"),
        };
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).applyConfirmedReportBody({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId: "11111111-1111-1111-1111-111111111111",
    content: { tabs: { Progress: { markdown: "- shipped assistant confirms\n" } } },
  });

  expect(result.id).toBe("11111111-1111-1111-1111-111111111111");
  expect(updates[0]).toMatchObject({
    content: { tabs: { Progress: { markdown: "- shipped assistant confirms\n" } } },
  });
});

test("a confirmed assistant draft stays put while the author edits the working body", async () => {
  const reportId = "22222222-2222-4222-8222-222222222222";
  let stored: ReportContent = { tabs: { Progress: { markdown: "- old\n" } } };
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: reportId,
        authorId: "user-1",
        kind: "member",
        status: "draft",
        hiddenFromAuthor: false,
        settingsId: null,
        content: stored,
        cycle: { year: 2026, week: 40 },
        submissions: [],
      }),
      update: async (query: { data: { content: ReportContent; status?: string } }) => {
        stored = query.data.content;
        return {
          id: reportId,
          status: query.data.status ?? "draft",
          updatedAt: new Date("2026-10-08T12:00:00.000Z"),
        };
      },
    },
  } as unknown as PrismaClient;
  const catalog = new RecordCatalog(db);
  const assistantTabs = { Progress: { markdown: "- 本周提交了 8 次代码。\n" } };

  await catalog.applyConfirmedReportBody({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId,
    content: { tabs: assistantTabs },
  });

  expect(stored.tabs).toEqual(assistantTabs);
  expect(stored.assistantDraft).toEqual({ tabs: assistantTabs });

  const editedTabs = { Progress: { markdown: "- 本周解决了登录超时。\n" } };
  await catalog.saveReportContent({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId,
    content: { tabs: editedTabs },
  });

  expect(stored.tabs).toEqual(editedTabs);
  expect(stored.assistantDraft).toEqual({ tabs: assistantTabs });
  expect(reportContentForAuthor(stored).assistantDraft).toBeUndefined();
  expect(reportContentForRecipient(stored).assistantDraft).toBeUndefined();
  expect(reportContentForAuthor(stored).tabs).toEqual(editedTabs);
});
