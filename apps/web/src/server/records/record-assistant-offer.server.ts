import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { currentIsoWeek } from "#src/features/records/records-content";
import { parseRecordAssistantPayload } from "#src/features/records/weekly-highlight-extract";
import { formatOfferSendWeekTitle } from "#src/features/records/weekly-send-window";
import { zonedCalendarDate } from "#src/features/records/weekly-report-schedule-due";
import { offerSendRecipient } from "./weekly-report-offer-recipient.server";
import { recordDistribution } from "./record-distribution.server";
import { recordSideChat } from "./record-side-chat.server";
import type { WeeklyReportNotifier } from "./weekly-report-distribution.server";
import { rebaseLiveFormatToCurrentWeek } from "./record-catalog-format.server";

type Db = PrismaClient;
type SideChatComments = Awaited<ReturnType<ReturnType<typeof recordSideChat>["listComments"]>>;

export function recordAssistantOffer(db: Db, notifier?: WeeklyReportNotifier) {
  async function writeAssistantComment(input: {
    workspaceId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    payload?: Record<string, unknown>;
    assistantSessionId: string;
  }) {
    return db.recordComment.create({
      data: {
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        authorType: "assistant",
        authorUserId: null,
        body: input.body,
        assistantSessionId: input.assistantSessionId,
        ...(input.payload ? { payload: input.payload as Prisma.InputJsonValue } : {}),
        reportId: input.subjectType === "report" ? input.subjectId : null,
        cycleId: input.subjectType === "cycle" ? input.subjectId : null,
      },
    });
  }

  async function ensureAssistantIntro(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    surface: "format" | "member-leader" | "member-assignee" | "plain";
    assistantSessionId: string;
    now?: Date;
  }) {
    const existing = await recordSideChat(db).listComments(input);
    if (input.surface === "plain" || input.surface === "member-leader") {
      return existing;
    }

    if (input.surface === "format" && input.subjectType === "report") {
      return ensureFormatSendOfferIntro({ ...input, existing });
    }

    if (existing.length > 0) return existing;

    if (input.surface === "member-assignee" && input.subjectType === "report") {
      const report = await db.weeklyReport.findFirst({
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
        await writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          assistantSessionId: input.assistantSessionId,
          body: `hi，${displayName}，${report.cycle.year} W${report.cycle.week}的工作周报模板已收到，是否需要我来帮你直接生成？`,
          payload: { kind: "offer-help-generate" },
        });
      }
    }

    return recordSideChat(db).listComments(input);
  }

  async function ensureFormatSendOfferIntro(input: {
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
      await hasCurrentWeekOfferSend({
        workspaceId: input.workspaceId,
        reportId: input.subjectId,
        now: input.now,
      })
    ) {
      return input.existing;
    }

    const offer = await buildFormatOfferSend({
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.subjectId,
      now: input.now,
    });
    if (!offer) return input.existing;

    await writeAssistantComment({
      workspaceId: input.workspaceId,
      subjectType: "report",
      subjectId: input.subjectId,
      assistantSessionId: input.assistantSessionId,
      body: offer.body,
      payload: offer.payload,
    });
    return recordSideChat(db).listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.subjectId,
      assistantSessionId: input.assistantSessionId,
    });
  }

  /** True when any session (or null-session) already has this week's offer-send card. */
  async function hasCurrentWeekOfferSend(input: {
    workspaceId: string;
    reportId: string;
    now?: Date;
  }): Promise<boolean> {
    const { year, week } = currentIsoWeek(zonedCalendarDate(input.now ?? new Date()));
    const rows = await db.recordComment.findMany({
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

  async function buildFormatOfferSend(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    now?: Date;
  }): Promise<{
    body: string;
    payload: Extract<ReturnType<typeof parseRecordAssistantPayload>, { kind: "offer-send" }>;
  } | null> {
    const sendState = await recordDistribution(db, notifier).loadFormatSendState(input);
    if (!sendState.canSend) return null;

    const report = await db.weeklyReport.findFirst({
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
        : await rebaseLiveFormatToCurrentWeek(db, {
            workspaceId: input.workspaceId,
            userId: input.userId,
            reportId: report.id,
            cycle: report.cycle,
            now,
          });

    const settings = await db.weeklyReportTemplate.findFirst({
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
      const memberships = await db.workspaceMembership.findMany({
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

  return { ensureAssistantIntro };
}
