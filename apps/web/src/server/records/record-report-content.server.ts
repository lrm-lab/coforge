import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  currentIsoWeek,
  insertAssistantReportBody,
  isAutoSendCancelled,
  memberReportMatchesReceived,
  normalizeReportContent,
  publishMemberReportDelivery,
  reportBodyRestoreView,
  reportContentForAuthor,
  switchReportBodyVersion,
  reportTabsEqual,
  retainMemberReportDelivery,
  withAutoSendCancelled,
  type ReportContent,
} from "#src/features/records/records-content";
import { canEditWeeklyReportContent } from "./weekly-report-editability.server";
import { requireMembership } from "./record-catalog-access.server";
import { syncSettingsOutlineFromFormat } from "./record-catalog-format.server";
import { canSendWeeklyAssignmentsNow } from "#src/features/records/weekly-send-window";
import { zonedCalendarDate } from "#src/features/records/weekly-report-schedule-due";

type Db = PrismaClient;

async function memberSubmitMatchesReceived(
  db: Db,
  input: { workspaceId: string; sourceTemplateId: string | null; content: ReportContent },
) {
  if (memberReportMatchesReceived(input.content)) return true;
  if (input.content.received || !input.sourceTemplateId) return false;
  const template = await db.weeklyReport.findFirst({
    where: { id: input.sourceTemplateId, workspaceId: input.workspaceId },
    select: { content: true },
  });
  if (!template) return false;
  return memberReportMatchesReceived({
    ...input.content,
    received: { tabs: normalizeReportContent(template.content).tabs ?? {} },
  });
}

function isSentMemberReport(kind: string, status: string) {
  return kind === "member" && (status === "submitted" || status === "shared");
}

export function recordReportContent(db: Db) {
  async function writeAssistantComment(input: {
    workspaceId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
  }) {
    return db.recordComment.create({
      data: {
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        authorType: "assistant",
        authorUserId: null,
        body: input.body,
        assistantSessionId: null,
        reportId: input.subjectType === "report" ? input.subjectId : null,
        cycleId: input.subjectType === "cycle" ? input.subjectId : null,
      },
    });
  }
  async function saveReportContent(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    content: ReportContent;
    status?: "draft" | "submitted" | "shared";
    now?: Date;
    /** Explicit「保存」: ask assistant whether to send when still eligible. */
    askToSend?: boolean;
    /**
     * Assistant body-edit message that should become the latest version.
     * The same message id does not capture the pair again.
     */
    assistantInsertMessageId?: string;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: {
        id: true,
        authorId: true,
        kind: true,
        status: true,
        hiddenFromAuthor: true,
        settingsId: true,
        content: true,
        sourceTemplateId: true,
        cycle: { select: { year: true, week: true } },
        submissions: { where: { kind: "member" }, select: { id: true }, take: 1 },
      },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (report.kind === "member" && report.hiddenFromAuthor) throw new AppError("NOT_FOUND");
    if (
      !canEditWeeklyReportContent({
        viewerUserId: input.userId,
        authorUserId: report.authorId,
      })
    ) {
      throw new AppError("ACCESS_DENIED");
    }
    const stored = normalizeReportContent(report.content);
    let content = normalizeReportContent(input.content);
    if (stored.schedule && !content.schedule) {
      content = { ...content, schedule: stored.schedule };
    }
    if (stored.keyPointPrompts && !content.keyPointPrompts) {
      content = { ...content, keyPointPrompts: stored.keyPointPrompts };
    }
    if (stored.keyPointExtraction && !content.keyPointExtraction) {
      content = { ...content, keyPointExtraction: stored.keyPointExtraction };
    }
    if (stored.assistantDraft && !content.assistantDraft) {
      content = { ...content, assistantDraft: stored.assistantDraft };
    }
    if (stored.bodyRestore && !content.bodyRestore) {
      content = { ...content, bodyRestore: stored.bodyRestore };
    }
    if (stored.received && !content.received) {
      content = { ...content, received: stored.received };
    }
    if (input.assistantInsertMessageId) {
      content = insertAssistantReportBody(stored, content, input.assistantInsertMessageId);
    }
    if (
      report.kind === "member" &&
      (input.status === "submitted" || input.status === "shared") &&
      (await memberSubmitMatchesReceived(db, {
        workspaceId: input.workspaceId,
        sourceTemplateId: report.sourceTemplateId,
        content,
      }))
    ) {
      throw new AppError("INVALID_INPUT", { errorId: "weekly-report-unmodified" });
    }
    const publishing = isSentMemberReport(report.kind, input.status ?? "");
    const alreadySent = isSentMemberReport(report.kind, report.status);
    if (publishing) {
      content = publishMemberReportDelivery(content);
    } else if (alreadySent) {
      content = retainMemberReportDelivery(stored, content);
    }
    const now = input.now ?? new Date();
    // Live format may still be bound to the week it was created; cancel/send keys follow the calendar week.
    const week = currentIsoWeek(zonedCalendarDate(now));
    const wasCancelled = isAutoSendCancelled(stored, week.year, week.week);
    let autoSendJustCancelled = false;
    if (
      report.kind === "template" &&
      report.submissions.length === 0 &&
      report.settingsId &&
      !reportTabsEqual(stored, content)
    ) {
      const settings = await db.weeklyReportTemplate.findFirst({
        where: {
          id: report.settingsId,
          workspaceId: input.workspaceId,
          ownerId: input.userId,
        },
        select: { sendWeekday: true, sendTime: true, scheduleEnabled: true },
      });
      if (
        settings?.scheduleEnabled &&
        canSendWeeklyAssignmentsNow({
          applied: true,
          alreadySent: false,
          sendWeekday: settings.sendWeekday,
          sendTime: settings.sendTime,
          scheduleEnabled: true,
          now,
        })
      ) {
        content = withAutoSendCancelled(content, week.year, week.week);
        autoSendJustCancelled = !wasCancelled;
      }
    }
    const updated = await db.weeklyReport.update({
      where: { id: report.id },
      data: {
        content: content as unknown as Prisma.InputJsonValue,
        ...(input.status
          ? {
              status: input.status,
              submittedAt:
                input.status === "submitted" || input.status === "shared" ? new Date() : null,
            }
          : {}),
      },
    });
    if (report.kind === "template" && report.submissions.length === 0 && report.settingsId) {
      await syncSettingsOutlineFromFormat(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId: report.settingsId,
        content,
      });
    }

    let assistantPosted = false;
    if (report.kind === "template" && report.submissions.length === 0) {
      if (autoSendJustCancelled) {
        await writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: report.id,
          body: "已取消本周自动发送。保存后请手动发送周报模板。",
        });
        assistantPosted = true;
      }
      if (input.askToSend) {
        // Do not post a null-session offer-send here — that would gate every
        // thread. The open side-panel session gets the card via ensureIntro.
        assistantPosted = true;
      }
    }

    const publishingMember =
      report.kind === "member" && (input.status === "submitted" || input.status === "shared");
    const firstMemberPublish =
      publishingMember && report.status !== "submitted" && report.status !== "shared";
    // Member first submit/share → Leader personal key-point extraction (LLM).
    if (firstMemberPublish) {
      try {
        const { startPersonalKeyPointExtraction } =
          await import("./weekly-report-key-points.server");
        await startPersonalKeyPointExtraction(db, {
          workspaceId: input.workspaceId,
          memberReportId: report.id,
        });
      } catch {
        // Extraction is best-effort; member submit must still succeed.
      }
    }
    if (publishingMember) {
      try {
        const { startWeeklyReportMemorySettlement } =
          await import("./weekly-report-memory-settlement.server");
        await startWeeklyReportMemorySettlement(db, {
          workspaceId: input.workspaceId,
          reportId: report.id,
        });
      } catch {
        // Memory settlement is best-effort; member submit must still succeed.
      }
    }

    return {
      id: updated.id,
      status: updated.status,
      updatedAt: updated.updatedAt.toISOString(),
      autoSendJustCancelled,
      assistantPosted,
      content: reportContentForAuthor(content),
      bodyRestoreView: reportBodyRestoreView(content),
    };
  }

  async function applyConfirmedReportBody(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    content: ReportContent;
    sourceMessageId?: string;
  }) {
    const content = normalizeReportContent(input.content);
    return saveReportContent({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.reportId,
      content: {
        ...content,
        ...(content.tabs && !input.sourceMessageId
          ? { assistantDraft: { tabs: { ...content.tabs } } }
          : {}),
      },
      askToSend: false,
      assistantInsertMessageId: input.sourceMessageId,
    });
  }

  async function switchWeeklyReportBodyVersion(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true, content: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (
      !canEditWeeklyReportContent({
        viewerUserId: input.userId,
        authorUserId: report.authorId,
      })
    ) {
      throw new AppError("ACCESS_DENIED");
    }
    return saveReportContent({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.reportId,
      content: switchReportBodyVersion(normalizeReportContent(report.content)),
      askToSend: false,
    });
  }

  /**
   * Assistant body-edit write. Does not ask-to-send; the user still controls send.
   * A message id captures the previous body so the author can switch back.
   */
  return { saveReportContent, applyConfirmedReportBody, switchWeeklyReportBodyVersion };
}
