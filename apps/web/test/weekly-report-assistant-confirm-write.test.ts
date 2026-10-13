import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  reportContentForAuthor,
  reportContentForRecipient,
  type ReportContent,
} from "#src/features/records/records-content";
import { RecordCatalog } from "#src/server/records/record-catalog.server";
import { applyIncomingWeeklyReportBodyEdit } from "#src/server/records/weekly-report-body-restore.server";
import { buildWeeklyReportAssistantSuggestionBody } from "#src/server/records/weekly-report-assistant-suggestion.server";

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

test("an assistant message writes the draft and a later switch returns the previous body", async () => {
  const reportId = "22222222-2222-4222-8222-222222222222";
  const messageId = "33333333-3333-4333-8333-333333333333";
  let stored: ReportContent = { tabs: { Progress: { markdown: "上一版" } } };
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
      update: async (query: { data: { content: ReportContent } }) => {
        stored = query.data.content;
        return {
          id: reportId,
          status: "draft",
          updatedAt: new Date("2026-10-12T12:00:00.000Z"),
        };
      },
    },
  } as unknown as PrismaClient;
  const catalog = new RecordCatalog(db);
  const written = await catalog.applyConfirmedReportBody({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId,
    content: { tabs: { Progress: { markdown: "最新版" } } },
    sourceMessageId: messageId,
  });
  expect(stored.tabs).toEqual({ Progress: { markdown: "最新版" } });
  expect(stored.bodyRestore?.previous.tabs).toEqual({ Progress: { markdown: "上一版" } });
  expect(written.bodyRestoreView).toEqual({
    sourceMessageId: messageId,
    revision: 1,
    showing: "latest",
  });

  await catalog.saveReportContent({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId,
    content: { tabs: { Progress: { markdown: "最新版改过" } } },
  });
  expect(stored.bodyRestore?.latest.tabs).toEqual({ Progress: { markdown: "最新版" } });

  const previous = await catalog.switchWeeklyReportBodyVersion({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId,
  });
  expect(previous.content.tabs).toEqual({ Progress: { markdown: "上一版" } });
  expect(previous.bodyRestoreView?.showing).toBe("previous");
  expect(stored.bodyRestore?.latest.tabs).toEqual({ Progress: { markdown: "最新版改过" } });

  const again = await catalog.applyConfirmedReportBody({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId,
    content: { tabs: { Progress: { markdown: "另一份" } } },
    sourceMessageId: messageId,
  });
  expect(again.bodyRestoreView?.revision).toBe(previous.bodyRestoreView?.revision);
  expect(stored.tabs).toEqual({ Progress: { markdown: "上一版" } });
});

test("only the member's weekly-report assistant writes a body-edit as it arrives", async () => {
  const reportId = "22222222-2222-4222-8222-222222222222";
  const messageId = "33333333-3333-4333-8333-333333333333";
  let stored: ReportContent = { tabs: { Progress: { markdown: "上一版" } } };
  const writes: string[] = [];
  const db = {
    user: { findUnique: async () => ({ id: "user-1" }) },
    weeklyReportAssistant: {
      findUnique: async () => ({ agentId: "assistant-agent" }),
    },
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
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
      update: async (query: { data: { content: ReportContent } }) => {
        writes.push("update");
        stored = query.data.content;
        return {
          id: reportId,
          status: "draft",
          updatedAt: new Date("2026-10-12T12:00:00.000Z"),
        };
      },
    },
  } as unknown as PrismaClient;
  const body = buildWeeklyReportAssistantSuggestionBody({
    displayText: "已整理好草稿。",
    suggestion: {
      type: "body-edit",
      reportId,
      summary: "本周草稿",
      content: { tabs: { Progress: { markdown: "最新版" } } },
    },
  });
  await applyIncomingWeeklyReportBodyEdit(db, {
    workspaceId: "workspace-1",
    agentId: "other-agent",
    target: "@ada",
    messageId,
    body,
  });
  expect(writes).toEqual([]);
  await applyIncomingWeeklyReportBodyEdit(db, {
    workspaceId: "workspace-1",
    agentId: "assistant-agent",
    target: "@ada",
    messageId,
    body,
  });
  expect(stored.tabs).toEqual({ Progress: { markdown: "最新版" } });
  expect(stored.bodyRestore?.previous.tabs).toEqual({ Progress: { markdown: "上一版" } });
});
