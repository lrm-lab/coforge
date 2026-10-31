import { humanLabel } from "#src/lib/human-label";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import {
  currentIsoWeek,
  isAutoSendCancelled,
  memberReportTitle,
  normalizeReportContent,
  type ReportContent,
} from "#src/features/records/records-content";
import {
  currentWeekTemplateTitle,
  isWeeklySendArmed,
} from "#src/features/records/weekly-send-window";
import {
  parseTemplateSections,
  type TemplateOutlineSection,
} from "#src/features/records/template-outline-sections";
import {
  loadMemberWeeksPage,
  REPORT_PERSON_SELECT,
  reportPersonView,
} from "./record-member-weeks.server";
import { zonedCalendarDate } from "#src/features/records/weekly-report-schedule-due";

type Db = PrismaClient;

function asReportContent(value: unknown): ReportContent {
  return normalizeReportContent(value);
}

async function requireMembership(db: Db, workspaceId: string, userId: string) {
  const row = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!row) throw new AppError("ACCESS_DENIED");
  return row;
}

/** Ensures a live format document for one applied settings row (may write on GET). */
export type EnsureFormatForSettings = (input: {
  workspaceId: string;
  userId: string;
  settingsId: string;
  settingsName: string;
  now?: Date;
  sections?: TemplateOutlineSection[];
  alignContent?: boolean;
}) => Promise<{ id: string }>;

/**
 * Records directory: cycle/report list metadata, favorites, notes, format chips.
 * Does not load report bodies for the directory; unread is an id-only JSON-path query.
 */
export async function loadRecordsCatalog(
  db: Db,
  input: { workspaceId: string; userId: string; now?: Date },
  ensureFormatForSettings: EnsureFormatForSettings,
) {
  const membership = await requireMembership(db, input.workspaceId, input.userId);
  const now = input.now ?? new Date();
  const currentWeek = currentIsoWeek(zonedCalendarDate(now));
  // Directory rows need report metadata only. Bodies stay out of these queries: unread is a
  // separate id-only JSON-path read for the viewer's own assignments, so cost does not grow
  // with every peer's markdown history. Member weeks are read a page at a time
  // (`loadMemberWeeksPage`).
  const [
    memberWeeksPage,
    mine,
    sentThisWeek,
    favorites,
    notes,
    me,
    unreadAssignmentIds,
    appliedSettings,
  ] = await Promise.all([
    loadMemberWeeksPage(db, input),
    db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "member",
        hiddenFromAuthor: false,
      },
      orderBy: [{ cycle: { year: "desc" } }, { cycle: { week: "desc" } }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        status: true,
        sourceTemplateId: true,
        cycle: { select: { year: true, week: true } },
      },
    }),
    // The viewer's templates assigned to members this week, by send settings.
    db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
        cycle: { year: currentWeek.year, week: currentWeek.week },
        submissions: { some: { kind: "member" } },
      },
      select: { settingsId: true },
    }),
    db.weeklyReportFavorite.findMany({
      where: { userId: input.userId, report: { workspaceId: input.workspaceId } },
      select: {
        report: {
          select: {
            id: true,
            authorId: true,
            hiddenFromAuthor: true,
            author: { select: REPORT_PERSON_SELECT },
            cycle: { select: { year: true, week: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    db.recordNote.findMany({
      where: { workspaceId: input.workspaceId, authorId: input.userId },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { id: true, title: true, body: true, authorId: true, updatedAt: true },
    }),
    db.user.findUnique({
      where: { id: input.userId },
      select: REPORT_PERSON_SELECT,
    }),
    db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "member",
        hiddenFromAuthor: false,
        content: { path: ["assignment", "unread"], equals: true },
      },
      select: { id: true },
    }),
    db.weeklyReportTemplate.findMany({
      where: { workspaceId: input.workspaceId, ownerId: input.userId, applied: true },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        sendWeekday: true,
        sendTime: true,
        scheduleEnabled: true,
        dimensions: true,
      },
    }),
  ]);
  const unreadMine = new Set(unreadAssignmentIds.map((row) => row.id));

  const formatChips: Array<{
    id: string | null;
    settingsId: string | null;
    name: string;
    year: number;
    week: number;
    sendArmed: boolean;
    alreadySent: boolean;
    autoSendCancelled: boolean;
    interactive: boolean;
    appliedSchedule: {
      sendWeekday: number;
      sendTime: string;
      scheduleEnabled: boolean;
    } | null;
  }> = await Promise.all(
    appliedSettings.map(async (settings) => {
      const formatReport = await ensureFormatForSettings({
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId: settings.id,
        settingsName: settings.name,
        now,
        sections: parseTemplateSections(settings.dimensions),
      });
      const alreadySentThisWeek = sentThisWeek.some((row) => row.settingsId === settings.id);
      const formatDoc = await db.weeklyReport.findFirst({
        where: { id: formatReport.id },
        select: { content: true },
      });
      const autoSendCancelled = isAutoSendCancelled(
        asReportContent(formatDoc?.content),
        currentWeek.year,
        currentWeek.week,
      );
      const sendArmed = isWeeklySendArmed({
        applied: true,
        alreadySent: alreadySentThisWeek,
        sendWeekday: settings.sendWeekday,
        sendTime: settings.sendTime,
        scheduleEnabled: settings.scheduleEnabled,
        autoSendCancelled,
        now,
      });
      return {
        id: formatReport.id,
        settingsId: settings.id,
        name: settings.name,
        year: currentWeek.year,
        week: currentWeek.week,
        sendArmed,
        alreadySent: alreadySentThisWeek,
        autoSendCancelled,
        interactive: true,
        appliedSchedule: {
          sendWeekday: settings.sendWeekday,
          sendTime: settings.sendTime,
          scheduleEnabled: settings.scheduleEnabled,
        },
      };
    }),
  );
  if (formatChips.length === 0) {
    formatChips.push({
      id: null,
      settingsId: null,
      name: currentWeekTemplateTitle(currentWeek.year, currentWeek.week),
      year: currentWeek.year,
      week: currentWeek.week,
      sendArmed: false,
      alreadySent: false,
      autoSendCancelled: false,
      interactive: false,
      appliedSchedule: null,
    });
  }

  return {
    actorUserId: input.userId,
    actorRole: membership.role,
    canManageWeeklyReports: true,
    actorDisplayName: me ? humanLabel(me) : "",
    actorAvatarUrl: me
      ? workspaceUserAvatarUrl(input.workspaceId, me.id, me.avatarObjectKey)
      : null,
    favorites: favorites
      .filter((row) => !(row.report.authorId === input.userId && row.report.hiddenFromAuthor))
      .map((row) => ({
        id: row.report.id,
        title: memberReportTitle(
          humanLabel(row.report.author),
          row.report.cycle.year,
          row.report.cycle.week,
        ),
        author: reportPersonView(input.workspaceId, row.report.author),
      })),
    myReports: mine.map((report) => ({
      id: report.id,
      title: memberReportTitle(
        me ? humanLabel(me) : report.title,
        report.cycle.year,
        report.cycle.week,
      ),
      status: report.status,
      unread: unreadMine.has(report.id),
      sourceTemplateId: report.sourceTemplateId,
      year: report.cycle.year,
      week: report.cycle.week,
    })),
    memberWeeks: memberWeeksPage.memberWeeks,
    /** Who the member weeks' submissions name (`authorId`). */
    people: memberWeeksPage.people,
    /** Where older member weeks start (`loadOlderMemberWeeks`); null when there are none. */
    memberWeeksBefore: memberWeeksPage.before,
    formatChips,
    notes: notes.map((note) => ({
      id: note.id,
      title: note.title,
      preview: note.body.slice(0, 80),
      authorId: note.authorId,
      updatedAt: note.updatedAt.toISOString(),
    })),
  };
}
