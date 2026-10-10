import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  normalizeReportContent,
  reportContentToMarkdown,
} from "#src/features/records/records-content";
import {
  applyMemorySettlement,
  buildWeeklyReportMemoryWakeText,
  parseStoredWeeklyReportMemory,
  type MemorySettlement,
} from "#src/server/records/weekly-report-memory.server";

export async function startWeeklyReportMemorySettlement(
  db: PrismaClient,
  input: {
    workspaceId: string;
    reportId: string;
    userLines?: readonly string[];
    wake?: (body: string) => Promise<void>;
  },
): Promise<{ started: boolean }> {
  const report = await db.weeklyReport.findFirst({
    where: { id: input.reportId, workspaceId: input.workspaceId, kind: "member" },
    select: {
      id: true,
      authorId: true,
      status: true,
      content: true,
      cycle: { select: { year: true, week: true } },
    },
  });
  if (!report || (report.status !== "submitted" && report.status !== "shared")) {
    return { started: false };
  }
  const assistant = await db.weeklyReportAssistant.findUnique({
    where: {
      workspaceId_userId: { workspaceId: input.workspaceId, userId: report.authorId },
    },
    select: { agentId: true },
  });
  if (!assistant) return { started: false };

  const content = normalizeReportContent(report.content);
  const userLines =
    input.userLines ??
    (input.wake
      ? []
      : await loadWeeklyReportMemoryUserLines(db, {
          workspaceId: input.workspaceId,
          userId: report.authorId,
          reportId: report.id,
        }));
  const body = buildWeeklyReportMemoryWakeText({
    reportId: report.id,
    year: report.cycle.year,
    week: report.cycle.week,
    draftMarkdown: content.assistantDraft
      ? reportContentToMarkdown({ tabs: content.assistantDraft.tabs })
      : "",
    finalMarkdown: reportContentToMarkdown(content),
    userLines,
  });
  if (input.wake) {
    await input.wake(body);
  } else {
    const { openWeeklyReportAssistantChat } = await import("./weekly-report-assistant-chat.server");
    const { ensureWeeklyReportAssistantChatSession } =
      await import("./weekly-report-assistant-chat-session.server");
    const ensured = await ensureWeeklyReportAssistantChatSession(db, {
      workspaceId: input.workspaceId,
      userId: report.authorId,
      subjectType: "report",
      subjectId: report.id,
    });
    await openWeeklyReportAssistantChat(db).postRequest({
      workspaceId: input.workspaceId,
      userId: report.authorId,
      requestId: crypto.randomUUID(),
      subjectType: "report",
      subjectId: report.id,
      sessionId: ensured.activeSessionId,
      platformTurn: true,
      body,
    });
  }
  return { started: true };
}

async function loadWeeklyReportMemoryUserLines(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; reportId: string },
): Promise<string[]> {
  try {
    const { openWeeklyReportAssistantChat } = await import("./weekly-report-assistant-chat.server");
    const { ensureWeeklyReportAssistantChatSession } =
      await import("./weekly-report-assistant-chat-session.server");
    const ensured = await ensureWeeklyReportAssistantChatSession(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
    });
    const listed = await openWeeklyReportAssistantChat(db).listMessages({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      sessionId: ensured.activeSessionId,
    });
    return listed.messages
      .filter((message) => message.author === "user")
      .map((message) => message.displayBody);
  } catch {
    return [];
  }
}

export async function applyWeeklyReportMemoryWriteBack(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    reportId: string;
    settlement: MemorySettlement;
  },
): Promise<{ reportId: string; status: "saved" }> {
  const report = await db.weeklyReport.findFirst({
    where: { id: input.reportId, workspaceId: input.workspaceId, kind: "member" },
    select: { authorId: true },
  });
  if (!report) throw new AppError("NOT_FOUND");
  const assistant = await db.weeklyReportAssistant.findFirst({
    where: {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      userId: report.authorId,
    },
    select: { id: true, memory: true },
  });
  if (!assistant) throw new AppError("ACCESS_DENIED");
  const next = applyMemorySettlement(
    parseStoredWeeklyReportMemory(assistant.memory),
    input.settlement,
  );
  await db.weeklyReportAssistant.update({
    where: { id: assistant.id },
    data: { memory: next },
  });
  return { reportId: input.reportId, status: "saved" };
}
