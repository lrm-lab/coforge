import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  currentIsoWeek,
  isAutoSendCancelled,
  isWeekSendDismissed,
  normalizeReportContent,
  type ReportContent,
} from "#src/features/records/records-content";
import { canSendWeeklyAssignmentsNow } from "#src/features/records/weekly-send-window";
import {
  isWeeklyScheduleDue,
  zonedCalendarDate,
} from "#src/features/records/weekly-report-schedule-due";
import {
  distributeWeeklyReport,
  retryWeeklyReportInvitations,
  type WeeklyReportNotifier,
} from "./weekly-report-distribution.server";
import { ensureFormatForSettings } from "./record-catalog-format.server";
import { requireMembership } from "./record-catalog-access.server";

type Db = PrismaClient;

export function recordDistribution(db: Db, notifier?: WeeklyReportNotifier) {
  async function loadFormatSendState(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }): Promise<{
    canSend: boolean;
    schedule: {
      sendWeekday: number;
      sendTime: string;
      scheduleEnabled: boolean;
      autoSendCancelled: boolean;
      alreadySent: boolean;
    } | null;
  }> {
    const now = input.now ?? new Date();
    const report = await db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
      },
      select: { id: true, settingsId: true, content: true },
    });
    if (!report?.settingsId) return { canSend: false, schedule: null };
    const settings = await db.weeklyReportTemplate.findFirst({
      where: {
        id: report.settingsId,
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        applied: true,
      },
      select: { id: true, sendWeekday: true, sendTime: true, scheduleEnabled: true },
    });
    if (!settings) return { canSend: false, schedule: null };
    const liveFormat = await db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        settingsId: settings.id,
        submissions: { none: { kind: "member" } },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (liveFormat?.id !== input.reportId) return { canSend: false, schedule: null };
    const currentWeek = currentIsoWeek(zonedCalendarDate(now));
    const alreadySent = Boolean(
      await db.weeklyReport.findFirst({
        where: {
          workspaceId: input.workspaceId,
          authorId: input.userId,
          kind: "template",
          settingsId: settings.id,
          cycle: { year: currentWeek.year, week: currentWeek.week },
          submissions: { some: { kind: "member" } },
        },
        select: { id: true },
      }),
    );
    const autoSendCancelled = isAutoSendCancelled(
      normalizeReportContent(report.content),
      currentWeek.year,
      currentWeek.week,
    );
    const weekDismissed = isWeekSendDismissed(
      normalizeReportContent(report.content),
      currentWeek.year,
      currentWeek.week,
    );
    const schedule = {
      sendWeekday: settings.sendWeekday,
      sendTime: settings.sendTime,
      scheduleEnabled: settings.scheduleEnabled,
      autoSendCancelled,
      alreadySent,
    };
    return {
      canSend:
        !weekDismissed &&
        canSendWeeklyAssignmentsNow({
          applied: true,
          alreadySent,
          sendWeekday: settings.sendWeekday,
          sendTime: settings.sendTime,
          scheduleEnabled: settings.scheduleEnabled,
          autoSendCancelled,
          now,
        }),
      schedule,
    };
  }
  async function canSendWeeklyAssignments(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }) {
    return (await loadFormatSendState(input)).canSend;
  }

  async function sendWeeklyAssignments(input: {
    workspaceId: string;
    userId: string;
    sourceReportId: string;
    content?: ReportContent;
    now?: Date;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const source = await db.weeklyReport.findFirst({
      where: {
        id: input.sourceReportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: { id: true, content: true, settingsId: true },
    });
    if (!source?.settingsId) throw new AppError("NOT_FOUND");

    const content = normalizeReportContent(input.content ?? normalizeReportContent(source.content));
    if (input.content) {
      await db.weeklyReport.update({
        where: { id: source.id },
        data: { content: content as unknown as Prisma.InputJsonValue },
      });
    }

    const sendSettings = await db.weeklyReportTemplate.findFirst({
      where: {
        id: source.settingsId,
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        applied: true,
      },
      include: { recipients: { select: { userId: true } } },
    });
    if (!sendSettings) throw new AppError("INVALID_INPUT", { errorId: "weekly-send-no-settings" });

    return distributeWeeklyReport(
      db,
      {
        workspaceId: input.workspaceId,
        userId: input.userId,
        templateId: source.settingsId,
        content,
        now: input.now,
      },
      notifier,
    );
  }

  /**
   * Cron entry: for each applied+scheduleEnabled settings row that is due now,
   * reuse sendWeeklyAssignments once per ISO week (skip if that cycle already has
   * Leader-sent assignments).
   */
  async function runDueScheduledWeeklyAssignments(input: { now?: Date } = {}) {
    const now = input.now ?? new Date();
    const settings = await db.weeklyReportTemplate.findMany({
      where: { applied: true, scheduleEnabled: true, frequency: "weekly" },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        ownerId: true,
        sendTime: true,
        sendWeekday: true,
      },
    });

    const results: Array<{
      workspaceId: string;
      templateId: string;
      status: "sent" | "skipped" | "failed";
      reason?: string;
      parentId?: string;
      assignmentCount?: number;
      notifications?: Array<{ reportId: string; status: string }>;
    }> = [];

    for (const row of settings) {
      if (
        !isWeeklyScheduleDue({
          now,
          sendWeekday: row.sendWeekday,
          sendTime: row.sendTime,
        })
      ) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "skipped",
          reason: "not-due",
        });
        continue;
      }

      const scheduleNow = zonedCalendarDate(now);
      const { year, week } = currentIsoWeek(scheduleNow);
      const alreadySent = await db.weeklyReport.findFirst({
        where: {
          workspaceId: row.workspaceId,
          kind: "template",
          authorId: row.ownerId,
          settingsId: row.id,
          cycle: { year, week },
          submissions: { some: { kind: "member" } },
        },
        select: { id: true },
      });
      if (alreadySent) {
        try {
          const notifications = await retryWeeklyReportInvitations(
            db,
            {
              workspaceId: row.workspaceId,
              parentId: alreadySent.id,
              templateName: row.name,
              year,
              week,
            },
            notifier,
          );
          const failed = notifications.some((result) => result.status === "failed");
          results.push({
            workspaceId: row.workspaceId,
            templateId: row.id,
            parentId: alreadySent.id,
            status: failed ? "failed" : "skipped",
            reason: failed ? "invitation-failed" : "already-sent",
            notifications,
          });
        } catch {
          results.push({
            workspaceId: row.workspaceId,
            templateId: row.id,
            status: "failed",
            reason: "invitation-failed",
          });
        }
        continue;
      }

      const liveFormat = await db.weeklyReport.findFirst({
        where: {
          workspaceId: row.workspaceId,
          authorId: row.ownerId,
          kind: "template",
          settingsId: row.id,
          submissions: { none: { kind: "member" } },
        },
        select: { content: true },
      });
      if (
        liveFormat &&
        isAutoSendCancelled(normalizeReportContent(liveFormat.content), year, week)
      ) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "skipped",
          reason: "auto-send-cancelled",
        });
        continue;
      }

      const source = await ensureFormatForSettings(db, {
        workspaceId: row.workspaceId,
        userId: row.ownerId,
        settingsId: row.id,
        settingsName: row.name,
        now: scheduleNow,
      });

      const membership = await db.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: row.workspaceId, userId: row.ownerId },
        },
        select: { userId: true },
      });
      if (!membership) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "skipped",
          reason: "source-author-not-member",
        });
        continue;
      }

      try {
        const sent = await sendWeeklyAssignments({
          workspaceId: row.workspaceId,
          userId: row.ownerId,
          sourceReportId: source.id,
          now,
        });
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: sent.notifications.some((result) => result.status === "failed")
            ? "failed"
            : "sent",
          parentId: sent.parentId,
          assignmentCount: sent.assignmentCount,
          notifications: sent.notifications,
        });
      } catch (error) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "failed",
          reason: error instanceof Error ? error.message : "send-failed",
        });
      }
    }

    return {
      checkedAt: now.toISOString(),
      sent: results.filter((row) => row.status === "sent").length,
      results,
    };
  }

  return {
    loadFormatSendState,
    canSendWeeklyAssignments,
    sendWeeklyAssignments,
    runDueScheduledWeeklyAssignments,
  };
}
