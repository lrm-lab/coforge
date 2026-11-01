import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  currentIsoWeek,
  normalizeReportContent,
  withWeekSendDismissed,
} from "#src/features/records/records-content";
import { zonedCalendarDate } from "#src/features/records/weekly-report-schedule-due";
import type { WeeklyReportNotifier } from "./weekly-report-distribution.server";
import { recordDistribution } from "./record-distribution.server";
import { recordSideChat } from "./record-side-chat.server";
import { requireMembership } from "./record-catalog-access.server";

type Db = PrismaClient;

export function recordReportSend(db: Db, notifier?: WeeklyReportNotifier) {
  async function confirmPromptedSend(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId, authorId: input.userId },
      select: { id: true, kind: true, content: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (report.kind === "member") {
      const { recordReportContent } = await import("./record-report-content.server");
      return recordReportContent(db).saveReportContent({
        workspaceId: input.workspaceId,
        userId: input.userId,
        reportId: report.id,
        content: normalizeReportContent(report.content),
        status: "submitted",
        now: input.now,
      });
    }
    if (report.kind === "template") {
      return recordDistribution(db, notifier).sendWeeklyAssignments({
        workspaceId: input.workspaceId,
        userId: input.userId,
        sourceReportId: report.id,
        now: input.now,
      });
    }
    throw new AppError("NOT_FOUND");
  }

  async function dismissWeeklyFormatSend(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId?: string | null;
    now?: Date;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
      },
      select: {
        id: true,
        content: true,
        submissions: { where: { kind: "member" }, select: { id: true }, take: 1 },
      },
    });
    if (!report || report.submissions.length > 0) throw new AppError("NOT_FOUND");
    const sendState = await recordDistribution(db, notifier).loadFormatSendState({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: report.id,
      now: input.now,
    });
    if (!sendState.canSend && !sendState.schedule) throw new AppError("INVALID_INPUT");
    const now = input.now ?? new Date();
    const { year, week } = currentIsoWeek(zonedCalendarDate(now));
    const content = withWeekSendDismissed(normalizeReportContent(report.content), year, week);
    await db.weeklyReport.update({
      where: { id: report.id },
      data: { content: content as unknown as Prisma.InputJsonValue },
    });
    await db.recordComment.create({
      data: {
        workspaceId: input.workspaceId,
        subjectType: "report",
        authorType: "assistant",
        authorUserId: null,
        body: "已取消本周周报。",
        assistantSessionId: input.assistantSessionId ?? null,
        reportId: report.id,
        cycleId: null,
      },
    });
    return recordSideChat(db).listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: report.id,
      assistantSessionId: input.assistantSessionId,
    });
  }

  return { confirmPromptedSend, dismissWeeklyFormatSend };
}
