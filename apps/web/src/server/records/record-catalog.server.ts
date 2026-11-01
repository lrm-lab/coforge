import type { WeeklyReportNotifier } from "./weekly-report-distribution.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  currentIsoWeek,
  isAutoSendCancelled,
  isValidTemplateName,
  normalizeReportContent,
  switchReportBodyVersion,
  withAutoSendCancelled,
  withWeekSendDismissed,
  type ReportContent,
} from "#src/features/records/records-content";
import { type RecordAssistantPayload } from "#src/features/records/weekly-highlight-extract";
import { isWeeklySendArmed } from "#src/features/records/weekly-send-window";
import { canEditWeeklyReportContent } from "./weekly-report-editability.server";
import { zonedCalendarDate } from "#src/features/records/weekly-report-schedule-due";
import { loadRecordsCatalog } from "./record-catalog-load.server";
import { requireMembership } from "./record-catalog-access.server";
import { recordSubject } from "./record-subject.server";
import { recordSideChat } from "./record-side-chat.server";
import { recordDistribution } from "./record-distribution.server";
import { recordAssistantCatalog } from "./record-assistant-catalog.server";
import { recordAssistantOffer } from "./record-assistant-offer.server";
import { recordReportContent } from "./record-report-content.server";
import { ensureFormatForSettings } from "./record-catalog-format.server";
import { asReportContent } from "./record-content-coercion.server";

type Db = PrismaClient;

export class RecordCatalog {
  constructor(
    private readonly db: Db,
    private readonly notifier?: WeeklyReportNotifier,
  ) {}

  /** Compatibility seam for existing report-content tests and callers. */
  saveReportContent(
    input: Parameters<ReturnType<typeof recordReportContent>["saveReportContent"]>[0],
  ) {
    return recordReportContent(this.db).saveReportContent(input);
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
      return recordReportContent(this.db).saveReportContent({
        workspaceId: input.workspaceId,
        userId: input.userId,
        reportId: report.id,
        content: normalizeReportContent(asReportContent(report.content)),
        status: "submitted",
        now: input.now,
      });
    }
    if (report.kind === "template") {
      return recordDistribution(this.db, this.notifier).sendWeeklyAssignments({
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

  /** Compatibility seam for existing subject tests and callers. */
  getSubject(input: { workspaceId: string; userId: string; id: string }) {
    return recordSubject(this.db, this.notifier).getSubject(input);
  }

  /** Compatibility seams for existing assistant catalog tests and callers. */
  loadAssistantContextManifest(
    input: Parameters<ReturnType<typeof recordAssistantCatalog>["loadAssistantContextManifest"]>[0],
  ) {
    return recordAssistantCatalog(this.db).loadAssistantContextManifest(input);
  }

  readAssistantReportSection(
    input: Parameters<ReturnType<typeof recordAssistantCatalog>["readAssistantReportSection"]>[0],
  ) {
    return recordAssistantCatalog(this.db).readAssistantReportSection(input);
  }

  /** Create a personal workspace note (Markdown body). */
  async applyConfirmedReportBody(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    content: ReportContent;
    sourceMessageId?: string;
  }) {
    const content = normalizeReportContent(input.content);
    return recordReportContent(this.db).saveReportContent({
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
    return recordReportContent(this.db).saveReportContent({
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

  ensureAssistantIntro(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    surface: "format" | "member-leader" | "member-assignee" | "plain";
    assistantSessionId: string;
    now?: Date;
  }) {
    return recordAssistantOffer(this.db, this.notifier).ensureAssistantIntro(input);
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
    const sendState = await recordDistribution(this.db, this.notifier).loadFormatSendState({
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
