import { humanLabel } from "#src/lib/human-label";
import {
  distributeWeeklyReport,
  retryWeeklyReportInvitations,
  type WeeklyReportNotifier,
} from "./weekly-report-distribution.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { offerSendRecipient } from "./weekly-report-offer-recipient.server";
import {
  currentIsoWeek,
  isAssignmentUnread,
  isAutoSendCancelled,
  isWeekSendDismissed,
  isValidTemplateName,
  memberReportTitle,
  insertAssistantReportBody,
  normalizeReportContent,
  publishMemberReportDelivery,
  reportBodyRestoreView,
  reportContentForAuthor,
  reportContentForRecipient,
  switchReportBodyVersion,
  memberReportMatchesReceived,
  reportTabsEqual,
  retainMemberReportDelivery,
  withAssignmentUnread,
  withAutoSendCancelled,
  withWeekSendDismissed,
  type ReportContent,
} from "#src/features/records/records-content";
import {
  parseRecordAssistantPayload,
  type RecordAssistantPayload,
} from "#src/features/records/weekly-highlight-extract";
import {
  canSendWeeklyAssignmentsNow,
  formatOfferSendWeekTitle,
  isWeeklySendArmed,
} from "#src/features/records/weekly-send-window";
import { parseTemplateSections } from "#src/features/records/template-outline-sections";
import { canEditWeeklyReportContent } from "./weekly-report-editability.server";
import { memoryForPrompt, parseStoredWeeklyReportMemory } from "./weekly-report-memory.server";
import { canReadReport } from "./report-readers.server";
import { writeKeyPointExtraction } from "./key-point-extraction-write.server";
import {
  isWeeklyScheduleDue,
  zonedCalendarDate,
} from "#src/features/records/weekly-report-schedule-due";
import { loadRecordsCatalog } from "./record-catalog-load.server";
import { requireMembership } from "./record-catalog-access.server";
import { REPORT_PERSON_SELECT, reportPersonView } from "./record-member-weeks.server";
import { recordSideChat } from "./record-side-chat.server";
import {
  ensureFormatForSettings,
  rebaseLiveFormatToCurrentWeek,
  syncSettingsOutlineFromFormat,
} from "./record-catalog-format.server";

type Db = PrismaClient;
type SideChatComments = Awaited<ReturnType<ReturnType<typeof recordSideChat>["listComments"]>>;

function asReportContent(value: unknown): ReportContent {
  return normalizeReportContent(value);
}

async function memberSubmitMatchesReceived(
  db: PrismaClient,
  input: {
    workspaceId: string;
    sourceTemplateId: string | null;
    content: ReportContent;
  },
): Promise<boolean> {
  if (memberReportMatchesReceived(input.content)) return true;
  if (input.content.received || !input.sourceTemplateId) return false;
  const template = await db.weeklyReport.findFirst({
    where: { id: input.sourceTemplateId, workspaceId: input.workspaceId },
    select: { content: true },
  });
  if (!template) return false;
  return memberReportMatchesReceived({
    ...input.content,
    received: { tabs: asReportContent(template.content).tabs ?? {} },
  });
}

function isSentMemberReport(kind: string, status: string): boolean {
  return kind === "member" && (status === "submitted" || status === "shared");
}

/** Authors keep the working body. Other viewers see the last send. */
function memberReportContentForViewer(
  content: ReportContent,
  input: { viewerIsAuthor: boolean; status: string },
): ReportContent {
  if (input.viewerIsAuthor || (input.status !== "submitted" && input.status !== "shared")) {
    return reportContentForAuthor(content);
  }
  return reportContentForRecipient(content);
}

export class RecordCatalog {
  constructor(
    private readonly db: Db,
    private readonly notifier?: WeeklyReportNotifier,
  ) {}

  private async loadFormatSendState(input: {
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
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
      },
      select: { id: true, settingsId: true, content: true },
    });
    if (!report?.settingsId) return { canSend: false, schedule: null };
    const settings = await this.db.weeklyReportTemplate.findFirst({
      where: {
        id: report.settingsId,
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        applied: true,
      },
      select: { id: true, sendWeekday: true, sendTime: true, scheduleEnabled: true },
    });
    if (!settings) return { canSend: false, schedule: null };
    const liveFormat = await this.db.weeklyReport.findFirst({
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
      await this.db.weeklyReport.findFirst({
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
      asReportContent(report.content),
      currentWeek.year,
      currentWeek.week,
    );
    const weekDismissed = isWeekSendDismissed(
      asReportContent(report.content),
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

  private async canSendWeeklyAssignments(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }) {
    return (await this.loadFormatSendState(input)).canSend;
  }

  async loadCatalog(input: { workspaceId: string; userId: string; now?: Date }) {
    return loadRecordsCatalog(this.db, input, (args) => ensureFormatForSettings(this.db, args));
  }

  /** Records rail dot: Leader preview hour, or an unread member assignment. */
  async loadNavAttention(input: { workspaceId: string; userId: string; now?: Date }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const unreadAssignment = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
        sourceTemplateId: { not: null },
        hiddenFromAuthor: false,
        content: { path: ["assignment", "unread"], equals: true },
      },
      select: { id: true },
    });
    if (unreadAssignment) return { preview: true as const };

    const now = input.now ?? new Date();
    const currentWeek = currentIsoWeek(zonedCalendarDate(now));
    const settings = await this.db.weeklyReportTemplate.findMany({
      where: {
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        applied: true,
        scheduleEnabled: true,
      },
      select: { id: true, sendWeekday: true, sendTime: true },
    });
    if (settings.length === 0) return { preview: false as const };
    const stream = {
      workspaceId: input.workspaceId,
      authorId: input.userId,
      kind: "template" as const,
      settingsId: { in: settings.map((row) => row.id) },
    };
    const [sent, live] = await Promise.all([
      this.db.weeklyReport.findMany({
        where: {
          ...stream,
          cycle: { year: currentWeek.year, week: currentWeek.week },
          submissions: { some: { kind: "member" } },
        },
        select: { settingsId: true },
      }),
      this.db.weeklyReport.findMany({
        where: { ...stream, submissions: { none: { kind: "member" } } },
        select: { settingsId: true, content: true },
      }),
    ]);
    const sentSettingsIds = new Set(sent.map((row) => row.settingsId));
    const liveContentBySettingsId = new Map<string | null, unknown>();
    for (const row of live) {
      if (!liveContentBySettingsId.has(row.settingsId))
        liveContentBySettingsId.set(row.settingsId, row.content);
    }
    for (const row of settings) {
      const armed = isWeeklySendArmed({
        applied: true,
        alreadySent: sentSettingsIds.has(row.id),
        sendWeekday: row.sendWeekday,
        sendTime: row.sendTime,
        scheduleEnabled: true,
        autoSendCancelled: isAutoSendCancelled(
          asReportContent(liveContentBySettingsId.get(row.id)),
          currentWeek.year,
          currentWeek.week,
        ),
        now,
      });
      if (armed) return { preview: true as const };
    }
    return { preview: false as const };
  }

  /**
   * Rename the live format document (and its settings stream). ISO week stays calendar-owned;
   * overview parents with member submissions are rejected.
   */
  async updateFormatReportMeta(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    title: string;
  }): Promise<{ id: string; title: string; year: number; week: number }> {
    await requireMembership(this.db, input.workspaceId, input.userId);
    if (!isValidTemplateName(input.title)) throw new AppError("INVALID_INPUT");
    const title = input.title.trim();
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: {
        id: true,
        authorId: true,
        kind: true,
        title: true,
        settingsId: true,
        cycle: { select: { year: true, week: true } },
        submissions: { where: { kind: "member" }, select: { id: true }, take: 1 },
      },
    });
    if (!report || report.kind !== "template") throw new AppError("NOT_FOUND");
    if (report.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    // Sent week overviews have member children; only the live format chip may rename.
    if (report.submissions.length > 0) throw new AppError("ACCESS_DENIED");

    if (title !== report.title) {
      await this.db.weeklyReport.update({
        where: { id: report.id },
        data: { title },
      });
      if (report.settingsId) {
        await this.db.weeklyReportTemplate.update({
          where: { id: report.settingsId },
          data: { name: title },
        });
      }
    }
    return {
      id: report.id,
      title,
      year: report.cycle.year,
      week: report.cycle.week,
    };
  }

  /**
   * The assistant send card confirms whichever report it names: a member report is
   * submitted, a template is distributed to its recipients.
   */
  async confirmPromptedSend(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
      },
      select: { id: true, kind: true, content: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (report.kind === "member") {
      return this.saveReportContent({
        workspaceId: input.workspaceId,
        userId: input.userId,
        reportId: report.id,
        content: normalizeReportContent(asReportContent(report.content)),
        status: "submitted",
        now: input.now,
      });
    }
    if (report.kind === "template") {
      return this.sendWeeklyAssignments({
        workspaceId: input.workspaceId,
        userId: input.userId,
        sourceReportId: report.id,
        now: input.now,
      });
    }
    throw new AppError("NOT_FOUND");
  }

  /**
   * Leader manual send: persist source content, create a new weekly parent for the
   * current cycle, and open unread assignments for configured recipients.
   */
  async sendWeeklyAssignments(input: {
    workspaceId: string;
    userId: string;
    sourceReportId: string;
    content?: ReportContent;
    now?: Date;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const source = await this.db.weeklyReport.findFirst({
      where: {
        id: input.sourceReportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: { id: true, content: true, settingsId: true },
    });
    if (!source?.settingsId) throw new AppError("NOT_FOUND");

    const content = normalizeReportContent(input.content ?? asReportContent(source.content));
    if (input.content) {
      await this.db.weeklyReport.update({
        where: { id: source.id },
        data: { content: content as unknown as Prisma.InputJsonValue },
      });
    }

    const sendSettings = await this.db.weeklyReportTemplate.findFirst({
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
      this.db,
      {
        workspaceId: input.workspaceId,
        userId: input.userId,
        templateId: source.settingsId,
        content,
        now: input.now,
      },
      this.notifier,
    );
  }

  /**
   * Cron entry: for each applied+scheduleEnabled settings row that is due now,
   * reuse sendWeeklyAssignments once per ISO week (skip if that cycle already has
   * Leader-sent assignments).
   */
  async runDueScheduledWeeklyAssignments(input: { now?: Date } = {}) {
    const now = input.now ?? new Date();
    const settings = await this.db.weeklyReportTemplate.findMany({
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
      const alreadySent = await this.db.weeklyReport.findFirst({
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
            this.db,
            {
              workspaceId: row.workspaceId,
              parentId: alreadySent.id,
              templateName: row.name,
              year,
              week,
            },
            this.notifier,
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

      const liveFormat = await this.db.weeklyReport.findFirst({
        where: {
          workspaceId: row.workspaceId,
          authorId: row.ownerId,
          kind: "template",
          settingsId: row.id,
          submissions: { none: { kind: "member" } },
        },
        select: { content: true },
      });
      if (liveFormat && isAutoSendCancelled(asReportContent(liveFormat.content), year, week)) {
        results.push({
          workspaceId: row.workspaceId,
          templateId: row.id,
          status: "skipped",
          reason: "auto-send-cancelled",
        });
        continue;
      }

      const source = await ensureFormatForSettings(this.db, {
        workspaceId: row.workspaceId,
        userId: row.ownerId,
        settingsId: row.id,
        settingsName: row.name,
        now: scheduleNow,
      });

      const membership = await this.db.workspaceMembership.findUnique({
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
        const sent = await this.sendWeeklyAssignments({
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

  async deleteMemberReport(input: { workspaceId: string; userId: string; reportId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
      },
      select: { id: true, status: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (report.status === "submitted" || report.status === "shared") {
      await this.db.weeklyReport.update({
        where: { id: report.id },
        data: { hiddenFromAuthor: true },
      });
      return { ok: true as const };
    }
    await this.db.weeklyReport.delete({ where: { id: report.id } });
    return { ok: true as const };
  }

  async setReportFavorite(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    favorited: boolean;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
      },
      select: {
        id: true,
        authorId: true,
        sourceTemplate: { select: { authorId: true } },
      },
    });
    if (!report) throw new AppError("NOT_FOUND");
    const canAccess =
      report.authorId === input.userId || report.sourceTemplate?.authorId === input.userId;
    if (!canAccess) {
      const favorite = await this.db.weeklyReportFavorite.findUnique({
        where: { userId_reportId: { userId: input.userId, reportId: report.id } },
        select: { reportId: true },
      });
      if (!favorite) throw new AppError("NOT_FOUND");
    }

    if (input.favorited) {
      await this.db.weeklyReportFavorite.upsert({
        where: {
          userId_reportId: { userId: input.userId, reportId: report.id },
        },
        create: { userId: input.userId, reportId: report.id },
        update: {},
      });
      return { favorited: true as const };
    }

    await this.db.weeklyReportFavorite.deleteMany({
      where: { userId: input.userId, reportId: report.id },
    });
    return { favorited: false as const };
  }

  /**
   * Deletes the Leader's overview week node only. Member submissions stay so
   * the author's「我的周报」copy and any「已收藏的周报」row remain; they are
   * unlinked from this parent so they leave the Leader's member-week tree.
   * The live format template in the same cycle is not this node.
   * Stamps auto-send cancelled for this ISO week on the live format so cron
   * does not recreate the week; manual send remains available.
   */
  async deleteOverviewReport(input: { workspaceId: string; userId: string; reportId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const overview = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: {
        id: true,
        cycleId: true,
        settingsId: true,
        cycle: { select: { year: true, week: true } },
      },
    });
    if (!overview) throw new AppError("NOT_FOUND");

    await this.db.$transaction(async (tx) => {
      await tx.weeklyReport.updateMany({
        where: {
          workspaceId: input.workspaceId,
          kind: "member",
          sourceTemplateId: overview.id,
        },
        data: { sourceTemplateId: null },
      });
      await tx.weeklyReport.deleteMany({ where: { id: { in: [overview.id] } } });
      const remaining = await tx.weeklyReport.count({
        where: { workspaceId: input.workspaceId, cycleId: overview.cycleId },
      });
      if (remaining === 0) {
        await tx.weeklyReportCycle.delete({ where: { id: overview.cycleId } });
      }
    });

    await this.cancelScheduledSendForWeek({
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: overview.settingsId,
      year: overview.cycle.year,
      week: overview.cycle.week,
    });
    return { ok: true as const };
  }

  /**
   * Deletes the viewer's「成员周报」week node scope for one ISO week: their
   * template parents in that cycle and member submissions under those parents.
   * Other leaders' templates/submissions are left alone. The cycle row is
   * removed only when nothing remains.
   * Cancels auto-send for each deleted settings stream's ISO week.
   */
  async deleteMemberWeek(input: { workspaceId: string; userId: string; cycleId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const cycle = await this.db.weeklyReportCycle.findFirst({
      where: { id: input.cycleId, workspaceId: input.workspaceId },
      select: { id: true, year: true, week: true },
    });
    if (!cycle) throw new AppError("NOT_FOUND");

    const myTemplates = await this.db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        kind: "template",
        authorId: input.userId,
      },
      select: { id: true, settingsId: true },
    });
    if (myTemplates.length === 0) throw new AppError("NOT_FOUND");
    const templateIds = myTemplates.map((row) => row.id);
    const settingsIds = [
      ...new Set(
        myTemplates
          .map((row) => row.settingsId)
          .filter((settingsId): settingsId is string => Boolean(settingsId)),
      ),
    ];

    const submissions = await this.db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        kind: "member",
        sourceTemplateId: { in: templateIds },
      },
      select: { id: true },
    });

    const reportIds = [...submissions.map((row) => row.id), ...templateIds];
    await this.db.$transaction(async (tx) => {
      if (reportIds.length > 0) {
        await tx.weeklyReport.deleteMany({ where: { id: { in: reportIds } } });
      }
      const remaining = await tx.weeklyReport.count({
        where: { workspaceId: input.workspaceId, cycleId: cycle.id },
      });
      if (remaining === 0) {
        await tx.weeklyReportCycle.delete({ where: { id: cycle.id } });
      }
    });

    for (const settingsId of settingsIds) {
      await this.cancelScheduledSendForWeek({
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId,
        year: cycle.year,
        week: cycle.week,
      });
    }
    return { ok: true as const };
  }

  /**
   * After a Leader deletes a sent week, stamp the live format so cron skips
   * that ISO week. No-op when there is no settings stream or live
   * format yet; ensureFormat will still see a later cancel only if stamped.
   */
  private async cancelScheduledSendForWeek(input: {
    workspaceId: string;
    userId: string;
    settingsId: string | null;
    year: number;
    week: number;
  }) {
    if (!input.settingsId) return;
    const liveFormat = await this.db.weeklyReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        settingsId: input.settingsId,
        submissions: { none: { kind: "member" } },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, content: true },
    });
    if (!liveFormat) return;
    const next = withAutoSendCancelled(asReportContent(liveFormat.content), input.year, input.week);
    await this.db.weeklyReport.update({
      where: { id: liveFormat.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
    });
  }

  private async memberMemoryPrompt(workspaceId: string, userId: string) {
    const assistant = await this.db.weeklyReportAssistant.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { memory: true },
    });
    return memoryForPrompt(parseStoredWeeklyReportMemory(assistant?.memory));
  }

  async loadAssistantContextManifest(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);

    if (input.subjectType === "report") {
      const subject = await this.getSubject({
        workspaceId: input.workspaceId,
        userId: input.userId,
        id: input.subjectId,
      });
      if (subject.type !== "report") throw new AppError("NOT_FOUND");
      const formats = await this.listAssistantTemplateFormats(input);
      return {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        cycle: subject.report.cycle,
        kind: subject.report.kind,
        status: subject.report.status,
        structure: Object.keys(subject.report.content.tabs ?? {}),
        availableData: [
          "current_report",
          "template",
          "submission_status",
          "visible_member_reports",
          "favorites",
        ],
        templateFormats: formats.templates,
        templateFormatsNextCursor: formats.nextCursor,
        contextVersion: subject.report.updatedAt,
        ...(subject.report.kind === "member"
          ? await this.memberMemoryPrompt(input.workspaceId, subject.report.author.userId)
          : {}),
      } as const;
    }

    const cycle = await this.db.weeklyReportCycle.findFirst({
      where: { id: input.subjectId, workspaceId: input.workspaceId },
      select: {
        id: true,
        year: true,
        week: true,
        title: true,
        createdAt: true,
        _count: { select: { reports: true } },
      },
    });
    if (!cycle) throw new AppError("NOT_FOUND");
    const formats = await this.listAssistantTemplateFormats(input);
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      cycle: { id: cycle.id, year: cycle.year, week: cycle.week, title: cycle.title },
      structure: [],
      availableData: ["cycle", "visible_member_reports", "submission_status"],
      templateFormats: formats.templates,
      templateFormatsNextCursor: formats.nextCursor,
      reportCount: cycle._count.reports,
      contextVersion: cycle.createdAt.toISOString(),
    } as const;
  }

  /** Shared format discovery; only owners receive editable delivery settings. */
  async listAssistantTemplateFormats(input: {
    workspaceId: string;
    userId: string;
    query?: string;
    cursor?: string;
    limit?: number;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const limit = Math.max(1, Math.min(input.limit ?? 25, 50));
    const rows = await this.db.weeklyReportTemplate.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.query ? { name: { contains: input.query, mode: "insensitive" as const } } : {}),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      include: {
        owner: { select: { displayName: true, username: true } },
        recipients: { select: { userId: true } },
      },
    });
    return {
      templates: rows.slice(0, limit).map((template) => ({
        id: template.id,
        name: template.name,
        sections: parseTemplateSections(template.dimensions),
        active: template.applied,
        owner: humanLabel(template.owner),
        updatedAt: template.updatedAt.toISOString(),
        canManage: template.ownerId === input.userId,
        ...(template.ownerId === input.userId
          ? {
              scheduleEnabled: template.scheduleEnabled,
              sendWeekday: template.sendWeekday,
              sendTime: template.sendTime,
              timeZone: "Asia/Shanghai",
              allMembers: template.allMembers,
              recipientUserIds: template.recipients.map((recipient) => recipient.userId),
            }
          : {}),
      })),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }

  async listAssistantVisibleReports(input: {
    workspaceId: string;
    userId: string;
    cycleId?: string;
    cursor?: string;
    limit?: number;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const limit = Math.max(1, Math.min(input.limit ?? 25, 50));
    const rows = await this.db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.cycleId ? { cycleId: input.cycleId } : {}),
        kind: "member",
        status: { in: ["submitted", "shared"] },
        OR: [{ authorId: input.userId }, { sourceTemplate: { authorId: input.userId } }],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(input.cursor ? { skip: 1, cursor: { id: input.cursor } } : {}),
      take: limit + 1,
      select: {
        id: true,
        cycleId: true,
        authorId: true,
        title: true,
        status: true,
        submittedAt: true,
        updatedAt: true,
        author: { select: { username: true, displayName: true } },
        cycle: { select: { year: true, week: true, title: true } },
      },
    });
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    return {
      reports: visible.map((row) => ({
        id: row.id,
        cycleId: row.cycleId,
        title: row.title,
        status: row.status,
        submittedAt: row.submittedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
        author: {
          username: row.author.username,
          displayName: humanLabel(row.author),
        },
        cycle: row.cycle,
        source: {
          kind: "weekly_report",
          reportId: row.id,
          userId: row.authorId,
        },
      })),
      nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null,
    } as const;
  }

  async readAssistantReportSection(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    section: string;
    maxCharacters?: number;
  }) {
    const subject = await this.getSubject({
      workspaceId: input.workspaceId,
      userId: input.userId,
      id: input.reportId,
    });
    if (subject.type !== "report") throw new AppError("NOT_FOUND");
    const section = input.section.trim();
    const tab = subject.report.content.tabs?.[section];
    if (!tab) throw new AppError("NOT_FOUND");
    const maxCharacters = Math.max(1, Math.min(input.maxCharacters ?? 12_000, 12_000));
    const markdown = tab.markdown.slice(0, maxCharacters);
    return {
      reportId: input.reportId,
      section,
      markdown,
      truncated: markdown.length < tab.markdown.length,
      source: {
        kind: "weekly_report",
        reportId: input.reportId,
        userId: subject.report.author.userId,
        displayName: subject.report.author.displayName,
        cycle: subject.report.cycle,
      },
    } as const;
  }

  async getSubject(input: { workspaceId: string; userId: string; id: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
      include: {
        author: {
          select: REPORT_PERSON_SELECT,
        },
        cycle: { select: { id: true, year: true, week: true, title: true } },
        sourceTemplate: {
          select: {
            authorId: true,
            content: true,
            author: {
              select: REPORT_PERSON_SELECT,
            },
          },
        },
      },
    });
    if (report) {
      const access = {
        id: report.id,
        kind: report.kind,
        authorId: report.author.id,
        hiddenFromAuthor: report.hiddenFromAuthor,
        sourceTemplateAuthorId: report.sourceTemplate?.authorId ?? null,
      };
      if (!(await canReadReport(this.db, input.workspaceId, access, input.userId)))
        throw new AppError("NOT_FOUND");

      const isTemplateAuthor = report.author.id === input.userId;
      let content =
        report.kind === "member"
          ? memberReportContentForViewer(asReportContent(report.content), {
              viewerIsAuthor: isTemplateAuthor,
              status: report.status,
            })
          : asReportContent(report.content);
      if (
        report.kind === "member" &&
        report.author.id === input.userId &&
        !content.received &&
        report.sourceTemplate?.content != null
      ) {
        content = {
          ...content,
          received: { tabs: asReportContent(report.sourceTemplate.content).tabs ?? {} },
        };
      }
      const assignmentCount =
        report.kind === "template"
          ? await this.db.weeklyReport.count({
              where: {
                workspaceId: input.workspaceId,
                sourceTemplateId: report.id,
                kind: "member",
              },
            })
          : 0;
      const surface =
        report.kind === "template"
          ? assignmentCount > 0
            ? ("overview" as const)
            : ("format" as const)
          : undefined;
      const children =
        report.kind === "template"
          ? (
              await this.db.weeklyReport.findMany({
                where: {
                  workspaceId: input.workspaceId,
                  sourceTemplateId: report.id,
                  kind: "member",
                  // Overview lists every assignment; draft rows stay non-clickable in the UI.
                  ...(isTemplateAuthor ? {} : { authorId: input.userId }),
                },
                orderBy: { createdAt: "asc" },
                select: {
                  id: true,
                  title: true,
                  status: true,
                  submittedAt: true,
                  author: {
                    select: REPORT_PERSON_SELECT,
                  },
                },
              })
            ).map((child) => ({
              id: child.id,
              title: memberReportTitle(
                humanLabel(child.author),
                report.cycle.year,
                report.cycle.week,
              ),
              status: child.status,
              submittedAt: child.submittedAt?.toISOString() ?? null,
              author: reportPersonView(input.workspaceId, child.author),
            }))
          : [];
      return {
        type: "report" as const,
        report: {
          id: report.id,
          kind: report.kind,
          title:
            report.kind === "member"
              ? memberReportTitle(humanLabel(report.author), report.cycle.year, report.cycle.week)
              : report.title,
          status: report.status,
          content,
          bodyRestoreView:
            report.kind === "member" && report.author.id === input.userId
              ? reportBodyRestoreView(asReportContent(report.content))
              : null,
          submittedAt: report.submittedAt?.toISOString() ?? null,
          updatedAt: report.updatedAt.toISOString(),
          author: reportPersonView(input.workspaceId, report.author),
          sharedBy:
            report.kind === "member" && report.sourceTemplate?.author
              ? reportPersonView(input.workspaceId, report.sourceTemplate.author)
              : null,
          cycle: report.cycle,
          sourceTemplateId: report.sourceTemplateId,
          unread: isAssignmentUnread(content),
          editable: canEditWeeklyReportContent({
            viewerUserId: input.userId,
            authorUserId: report.author.id,
          }),
          surface,
          canSendAssignments:
            report.kind === "template" && surface === "format"
              ? await this.canSendWeeklyAssignments({
                  workspaceId: input.workspaceId,
                  userId: input.userId,
                  reportId: report.id,
                })
              : false,
          sendSchedule:
            report.kind === "template" && surface === "format"
              ? (
                  await this.loadFormatSendState({
                    workspaceId: input.workspaceId,
                    userId: input.userId,
                    reportId: report.id,
                  })
                ).schedule
              : undefined,
          favorited:
            report.kind === "member"
              ? Boolean(
                  await this.db.weeklyReportFavorite.findUnique({
                    where: {
                      userId_reportId: { userId: input.userId, reportId: report.id },
                    },
                    select: { reportId: true },
                  }),
                )
              : false,
          children,
        },
      };
    }

    const note = await this.db.recordNote.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
      include: {
        author: { select: { id: true, username: true, displayName: true } },
      },
    });
    if (note) {
      if (note.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
      return {
        type: "note" as const,
        note: {
          id: note.id,
          title: note.title,
          body: note.body,
          updatedAt: note.updatedAt.toISOString(),
          author: {
            userId: note.author.id,
            username: note.author.username,
            displayName: humanLabel(note.author),
          },
        },
      };
    }

    throw new AppError("NOT_FOUND");
  }

  /** Create a personal workspace note (Markdown body). */
  async createNote(input: { workspaceId: string; userId: string; title?: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const title = (input.title?.trim() || "Untitled").slice(0, 200);
    const note = await this.db.recordNote.create({
      data: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        title,
        body: "",
      },
      select: { id: true, title: true, updatedAt: true },
    });
    return {
      id: note.id,
      title: note.title,
      updatedAt: note.updatedAt.toISOString(),
      created: true as const,
    };
  }

  async saveNote(input: {
    workspaceId: string;
    userId: string;
    noteId: string;
    title?: string;
    body?: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const note = await this.db.recordNote.findFirst({
      where: { id: input.noteId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true },
    });
    if (!note) throw new AppError("NOT_FOUND");
    if (note.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    const data: { title?: string; body?: string } = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new AppError("INVALID_INPUT");
      data.title = title.slice(0, 200);
    }
    if (input.body !== undefined) data.body = input.body;
    if (!Object.keys(data).length) {
      const current = await this.db.recordNote.findUniqueOrThrow({
        where: { id: note.id },
        select: { id: true, title: true, updatedAt: true },
      });
      return {
        id: current.id,
        title: current.title,
        updatedAt: current.updatedAt.toISOString(),
      };
    }
    const updated = await this.db.recordNote.update({
      where: { id: note.id },
      data,
      select: { id: true, title: true, updatedAt: true },
    });
    return {
      id: updated.id,
      title: updated.title,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async deleteNote(input: { workspaceId: string; userId: string; noteId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const note = await this.db.recordNote.findFirst({
      where: { id: input.noteId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true },
    });
    if (!note) throw new AppError("NOT_FOUND");
    if (note.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    await this.db.recordNote.delete({ where: { id: note.id } });
    return { ok: true as const };
  }

  async markAssignmentOpened(input: { workspaceId: string; userId: string; reportId: string }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
      },
      select: { id: true, content: true, sourceTemplateId: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (!report.sourceTemplateId) return { id: report.id, unread: false as const };
    const content = asReportContent(report.content);
    if (!isAssignmentUnread(content)) return { id: report.id, unread: false as const };
    const next = withAssignmentUnread(content, false);
    await this.db.weeklyReport.update({
      where: { id: report.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
    });
    return { id: report.id, unread: false as const };
  }

  async saveReportContent(input: {
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
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
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
    const stored = asReportContent(report.content);
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
      (await memberSubmitMatchesReceived(this.db, {
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
      const settings = await this.db.weeklyReportTemplate.findFirst({
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
    const updated = await this.db.weeklyReport.update({
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
      await syncSettingsOutlineFromFormat(this.db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId: report.settingsId,
        content,
      });
    }

    let assistantPosted = false;
    if (report.kind === "template" && report.submissions.length === 0) {
      if (autoSendJustCancelled) {
        await this.writeAssistantComment({
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
        await startPersonalKeyPointExtraction(this.db, {
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
        await startWeeklyReportMemorySettlement(this.db, {
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

  /**
   * Assistant body-edit write. Does not ask-to-send; the user still controls send.
   * A message id captures the previous body so the author can switch back.
   */
  async applyConfirmedReportBody(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    content: ReportContent;
    sourceMessageId?: string;
  }) {
    const content = normalizeReportContent(input.content);
    return this.saveReportContent({
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

  /** Show the other stored version, keeping edits on the side the author leaves. */
  async switchWeeklyReportBodyVersion(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
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
    const next = switchReportBodyVersion(asReportContent(report.content));
    return this.saveReportContent({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.reportId,
      content: next,
      askToSend: false,
    });
  }

  /**
   * Side-chat Confirm for a key-point-edit suggestion: writes markdown into
   * `content.keyPointExtraction` without replacing the report body tabs.
   */
  async applyConfirmedKeyPointMarkdown(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    markdown: string;
    promptSnapshot?: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const markdown = input.markdown.trim();
    if (!markdown) throw new AppError("INVALID_INPUT");

    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: {
        id: true,
        authorId: true,
        content: true,
        kind: true,
        workspace: { select: { slug: true } },
      },
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

    const { loadSubmittedTeamKeyPointSources, linkifyTeamKeyPointMarkdown } =
      await import("./weekly-report-key-points.server");
    const { DEFAULT_PERSONAL_KEY_POINT_PROMPT, DEFAULT_TEAM_KEY_POINT_PROMPT } =
      await import("#src/features/records/records-content");
    const content = asReportContent(report.content);
    const promptSnapshot =
      input.promptSnapshot ??
      content.keyPointExtraction?.promptSnapshot ??
      (report.kind === "template"
        ? DEFAULT_TEAM_KEY_POINT_PROMPT
        : DEFAULT_PERSONAL_KEY_POINT_PROMPT);
    const linkedMarkdown =
      report.kind === "template"
        ? linkifyTeamKeyPointMarkdown(
            markdown,
            await loadSubmittedTeamKeyPointSources(this.db, {
              workspaceId: input.workspaceId,
              overviewReportId: report.id,
            }),
            { workspaceSlug: report.workspace.slug, overviewReportId: report.id },
          )
        : markdown;
    const next = await writeKeyPointExtraction(this.db, {
      reportId: report.id,
      content,
      extraction: {
        status: "ready",
        promptSnapshot,
        markdown: linkedMarkdown,
        generatedAt: new Date().toISOString(),
      },
    });
    return { id: report.id, content: next };
  }

  /**
   * Side-chat Ignore for a key-point-edit card: drop the pending draft and
   * restore `ready` with the previously published markdown (unchanged).
   */
  async dismissKeyPointConfirmDraft(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true, content: true, kind: true },
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

    const content = asReportContent(report.content);
    const existing = content.keyPointExtraction;
    if (!existing || existing.status !== "awaiting_confirm") {
      return { id: report.id, content };
    }

    const { DEFAULT_PERSONAL_KEY_POINT_PROMPT, DEFAULT_TEAM_KEY_POINT_PROMPT } =
      await import("#src/features/records/records-content");
    const promptSnapshot =
      existing.promptSnapshot ||
      (report.kind === "template"
        ? DEFAULT_TEAM_KEY_POINT_PROMPT
        : DEFAULT_PERSONAL_KEY_POINT_PROMPT);
    const next = await writeKeyPointExtraction(this.db, {
      reportId: report.id,
      content,
      extraction: {
        status: existing.markdown ? "ready" : "failed",
        promptSnapshot,
        ...(existing.markdown ? { markdown: existing.markdown } : {}),
        ...(existing.markdown ? {} : { error: "dismissed_without_published_draft" }),
        ...(existing.generatedAt ? { generatedAt: existing.generatedAt } : {}),
      },
    });
    return { id: report.id, content: next };
  }

  private async writeAssistantComment(input: {
    workspaceId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    payload?: RecordAssistantPayload;
    assistantSessionId?: string | null;
  }) {
    return this.db.recordComment.create({
      data: {
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        authorType: "assistant",
        authorUserId: null,
        body: input.body,
        assistantSessionId: input.assistantSessionId ?? null,
        ...(input.payload ? { payload: input.payload as unknown as Prisma.InputJsonValue } : {}),
        reportId: input.subjectType === "report" ? input.subjectId : null,
        cycleId: input.subjectType === "cycle" ? input.subjectId : null,
      },
    });
  }

  /** Platform-owned assistant bubble for collect progress / packs. */
  async postAssistantCollectComment(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    payload?: RecordAssistantPayload;
    assistantSessionId?: string | null;
  }) {
    const { resolveLatestChatSessionId } =
      await import("./weekly-report-assistant-chat-session.server");
    const assistantSessionId =
      input.assistantSessionId ??
      (await resolveLatestChatSessionId(this.db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      }));
    await this.writeAssistantComment({ ...input, assistantSessionId });
    return recordSideChat(this.db).listComments({ ...input, assistantSessionId });
  }

  async ensureAssistantIntro(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    surface: "format" | "member-leader" | "member-assignee" | "plain";
    assistantSessionId: string;
    now?: Date;
  }) {
    const existing = await recordSideChat(this.db).listComments(input);
    if (input.surface === "plain" || input.surface === "member-leader") {
      return existing;
    }

    if (input.surface === "format" && input.subjectType === "report") {
      return this.ensureFormatSendOfferIntro({ ...input, existing });
    }

    if (existing.length > 0) return existing;

    if (input.surface === "member-assignee" && input.subjectType === "report") {
      const report = await this.db.weeklyReport.findFirst({
        where: {
          id: input.subjectId,
          workspaceId: input.workspaceId,
          kind: "member",
          authorId: input.userId,
        },
        select: {
          cycle: { select: { year: true, week: true } },
          author: { select: { displayName: true, username: true } },
        },
      });
      if (report) {
        const displayName = humanLabel(report.author);
        await this.writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          assistantSessionId: input.assistantSessionId,
          body: `hi，${displayName}，${report.cycle.year} W${report.cycle.week}的工作周报模板已收到，是否需要我来帮你直接生成？`,
          payload: { kind: "offer-help-generate" },
        });
      }
    }

    return recordSideChat(this.db).listComments(input);
  }

  /**
   * When the live format enters a sendable window, post one offer-send card for
   * the current ISO week. Earlier weeks' cards stay in the thread as history.
   * Another session that already has this week's card does not grow its own
   * send/cancel buttons.
   */
  private async ensureFormatSendOfferIntro(input: {
    workspaceId: string;
    userId: string;
    subjectId: string;
    assistantSessionId: string;
    existing: SideChatComments;
    now?: Date;
  }) {
    const { year, week } = currentIsoWeek(zonedCalendarDate(input.now ?? new Date()));
    const sessionHasCurrentWeek = input.existing.some((row) => {
      const payload = parseRecordAssistantPayload(row.payload);
      return payload?.kind === "offer-send" && payload.year === year && payload.week === week;
    });
    if (sessionHasCurrentWeek) return input.existing;

    if (
      await this.hasCurrentWeekOfferSend({
        workspaceId: input.workspaceId,
        reportId: input.subjectId,
        now: input.now,
      })
    ) {
      return input.existing;
    }

    const offer = await this.buildFormatOfferSend({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.subjectId,
      now: input.now,
    });
    if (!offer) return input.existing;

    await this.writeAssistantComment({
      workspaceId: input.workspaceId,
      subjectType: "report",
      subjectId: input.subjectId,
      assistantSessionId: input.assistantSessionId,
      body: offer.body,
      payload: offer.payload,
    });
    return recordSideChat(this.db).listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.subjectId,
      assistantSessionId: input.assistantSessionId,
    });
  }

  /** True when any session (or null-session) already has this week's offer-send card. */
  private async hasCurrentWeekOfferSend(input: {
    workspaceId: string;
    reportId: string;
    now?: Date;
  }): Promise<boolean> {
    const { year, week } = currentIsoWeek(zonedCalendarDate(input.now ?? new Date()));
    const rows = await this.db.recordComment.findMany({
      where: {
        workspaceId: input.workspaceId,
        subjectType: "report",
        reportId: input.reportId,
        authorType: "assistant",
      },
      select: { payload: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.some((row) => {
      const payload = parseRecordAssistantPayload(row.payload);
      return payload?.kind === "offer-send" && payload.year === year && payload.week === week;
    });
  }

  private async buildFormatOfferSend(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }): Promise<{
    body: string;
    payload: Extract<RecordAssistantPayload, { kind: "offer-send" }>;
  } | null> {
    const sendState = await this.loadFormatSendState(input);
    if (!sendState.canSend) return null;

    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
      },
      select: {
        id: true,
        settingsId: true,
        updatedAt: true,
        cycle: { select: { id: true, year: true, week: true } },
        author: { select: { displayName: true, username: true } },
        submissions: { where: { kind: "member" }, select: { id: true }, take: 1 },
      },
    });
    if (!report?.settingsId) return null;
    // Sent overviews keep their week; the live format advances with the calendar.
    const now = input.now ?? new Date();
    const { year, week } =
      (report.submissions?.length ?? 0) > 0
        ? { year: report.cycle.year, week: report.cycle.week }
        : await rebaseLiveFormatToCurrentWeek(this.db, {
            workspaceId: input.workspaceId,
            userId: input.userId,
            reportId: report.id,
            cycle: report.cycle,
            now,
          });

    const settings = await this.db.weeklyReportTemplate.findFirst({
      where: {
        id: report.settingsId,
        workspaceId: input.workspaceId,
        ownerId: input.userId,
      },
      select: {
        allMembers: true,
        recipients: {
          select: {
            user: {
              select: { id: true, displayName: true, username: true, avatarObjectKey: true },
            },
          },
        },
      },
    });
    if (!settings) return null;

    let people: Array<{
      id: string;
      displayName: string | null;
      username: string;
      avatarObjectKey: string | null;
    }>;
    if (settings.allMembers) {
      const memberships = await this.db.workspaceMembership.findMany({
        where: { workspaceId: input.workspaceId },
        select: {
          user: {
            select: { id: true, displayName: true, username: true, avatarObjectKey: true },
          },
        },
        take: 40,
      });
      people = memberships.map((row) => row.user);
    } else {
      people = settings.recipients.map((row) => row.user);
    }

    const recipients = people
      .filter((user) => user.id !== input.userId)
      .map((user) => offerSendRecipient(input.workspaceId, user));
    const displayName = humanLabel(report.author);
    return {
      body: `hi，${displayName}，${year} W${week}的工作周报模板已生成，请确认是否发送。`,
      payload: {
        kind: "offer-send",
        year,
        week,
        weekTitle: formatOfferSendWeekTitle(year, week),
        updatedAt: report.updatedAt.toISOString(),
        recipients: recipients.slice(0, 8),
        recipientTotal: recipients.length,
      },
    };
  }

  /** Move an unsent live format onto this week's cycle when the calendar advanced. */
  /** Leader cancels this week's template send entirely（取消本周周报）. */
  async dismissWeeklyFormatSend(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId?: string | null;
    now?: Date;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
      },
      select: {
        id: true,
        content: true,
        settingsId: true,
        cycle: { select: { year: true, week: true } },
        submissions: { where: { kind: "member" }, select: { id: true }, take: 1 },
      },
    });
    if (!report || report.submissions.length > 0) throw new AppError("NOT_FOUND");
    const sendState = await this.loadFormatSendState({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: report.id,
      now: input.now,
    });
    if (!sendState.canSend && !sendState.schedule) throw new AppError("INVALID_INPUT");

    // Stamp the calendar week the schedule tick arbitrates on — not the live
    // format's possibly stale creation cycle (otherwise auto-send still fires).
    const now = input.now ?? new Date();
    const { year, week } = currentIsoWeek(zonedCalendarDate(now));
    const content = withWeekSendDismissed(asReportContent(report.content), year, week);
    await this.db.weeklyReport.update({
      where: { id: report.id },
      data: { content: content as unknown as Prisma.InputJsonValue },
    });
    await this.writeAssistantComment({
      workspaceId: input.workspaceId,
      subjectType: "report",
      subjectId: report.id,
      assistantSessionId: input.assistantSessionId,
      body: "已取消本周周报。",
    });
    return recordSideChat(this.db).listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: report.id,
      assistantSessionId: input.assistantSessionId,
    });
  }

  /** Assignee accepts 「需要」— posts the user turn and the E2 clarifying reply. */
  async acceptMemberGenerateHelp(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId: string;
  }) {
    await requireMembership(this.db, input.workspaceId, input.userId);
    const report = await this.db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
      },
      select: { id: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    return recordSideChat(this.db).postSideChat({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: report.id,
      assistantSessionId: input.assistantSessionId,
      body: "需要",
    });
  }
}

export function recordCatalog(db: Db) {
  return new RecordCatalog(db);
}
