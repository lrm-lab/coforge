import { humanLabel } from "#src/lib/human-label";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import {
  currentIsoWeek,
  isAutoSendCancelled,
  memberReportTitle,
  memberWeekTitle,
  normalizeReportContent,
  type ReportContent,
} from "#src/features/records/records-content";
import {
  currentWeekTemplateTitle,
  isWeeklySendArmed,
  splitWeeklyTemplateRoles,
} from "#src/features/records/weekly-send-window";
import {
  parseTemplateSections,
  type TemplateOutlineSection,
} from "#src/features/records/template-outline-sections";
import { isVisibleTemplateSubmission } from "./template-submission-visibility.server";
import { zonedCalendarDate } from "#src/features/records/weekly-report-schedule-due";

type Db = PrismaClient;

const REPORT_PERSON_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarObjectKey: true,
} as const;

function reportPersonView(
  workspaceId: string,
  person: {
    id: string;
    username: string;
    displayName: string | null;
    avatarObjectKey: string | null;
  },
) {
  return {
    userId: person.id,
    username: person.username,
    displayName: humanLabel(person),
    avatarUrl: workspaceUserAvatarUrl(workspaceId, person.id, person.avatarObjectKey),
  };
}

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
  // Directory rows need report metadata only. Bodies stay out of this query: unread is a
  // separate id-only JSON-path read for the viewer's own assignments, so cost does not grow
  // with every peer's markdown history.
  const catalogReportSelect = {
    id: true,
    kind: true,
    authorId: true,
    title: true,
    status: true,
    sourceTemplateId: true,
    settingsId: true,
    hiddenFromAuthor: true,
    submittedAt: true,
    createdAt: true,
    author: { select: REPORT_PERSON_SELECT },
  } as const;
  const [cycles, favorites, notes, me, unreadAssignmentIds] = await Promise.all([
    db.weeklyReportCycle.findMany({
      where: { workspaceId: input.workspaceId },
      orderBy: [{ year: "desc" }, { week: "desc" }],
      select: {
        id: true,
        year: true,
        week: true,
        title: true,
        reports: {
          orderBy: { createdAt: "asc" },
          select: catalogReportSelect,
        },
      },
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
  ]);
  const unreadMine = new Set(unreadAssignmentIds.map((row) => row.id));

  const now = input.now ?? new Date();
  const templateEntries = cycles
    .flatMap((cycle) =>
      cycle.reports
        .filter((report) => report.kind === "template" && report.authorId === input.userId)
        .map((report) => ({ cycle, report })),
    )
    .sort((left, right) => right.report.createdAt.getTime() - left.report.createdAt.getTime());

  const currentWeek = currentIsoWeek(zonedCalendarDate(now));
  const classified = templateEntries.map(({ cycle, report }) => ({
    year: cycle.year,
    week: cycle.week,
    createdAtMs: report.createdAt.getTime(),
    settingsId: report.settingsId,
    hasAssignments: cycle.reports.some(
      (candidate) => candidate.kind === "member" && candidate.sourceTemplateId === report.id,
    ),
    entry: { cycle, report },
  }));
  const { overviews } = splitWeeklyTemplateRoles(classified);
  const appliedSettings = await db.weeklyReportTemplate.findMany({
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
  });

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
      const alreadySentThisWeek = classified.some(
        (row) =>
          row.settingsId === settings.id &&
          row.year === currentWeek.year &&
          row.week === currentWeek.week &&
          row.hasAssignments,
      );
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

  const memberWeeksMap = new Map<
    string,
    {
      year: number;
      week: number;
      title: string;
      cycleId: string;
      overviewReportId: string;
      submissions: Array<{
        id: string;
        title: string;
        status: string;
        submittedAt: string | null;
        sourceTemplateId: string | null;
        author: {
          userId: string;
          username: string;
          displayName: string;
          avatarUrl: string | null;
        };
      }>;
    }
  >();
  for (const {
    entry: { cycle, report },
  } of overviews) {
    const key = `${cycle.year}-${cycle.week}`;
    let week = memberWeeksMap.get(key);
    if (!week) {
      week = {
        year: cycle.year,
        week: cycle.week,
        title: memberWeekTitle(cycle.year, cycle.week),
        cycleId: cycle.id,
        overviewReportId: report.id,
        submissions: [],
      };
      memberWeeksMap.set(key, week);
    }
    for (const candidate of cycle.reports) {
      if (
        candidate.kind !== "member" ||
        candidate.sourceTemplateId !== report.id ||
        !isVisibleTemplateSubmission(candidate.status)
      ) {
        continue;
      }
      if (week.submissions.some((row) => row.id === candidate.id)) continue;
      const displayName = humanLabel(candidate.author);
      week.submissions.push({
        id: candidate.id,
        title: memberReportTitle(displayName, cycle.year, cycle.week),
        status: candidate.status,
        submittedAt:
          candidate.submittedAt instanceof Date ? candidate.submittedAt.toISOString() : null,
        sourceTemplateId: candidate.sourceTemplateId,
        author: reportPersonView(input.workspaceId, candidate.author),
      });
    }
  }
  const memberWeeks = [...memberWeeksMap.values()].sort((left, right) =>
    left.year !== right.year ? right.year - left.year : right.week - left.week,
  );

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
    myReports: cycles.flatMap((cycle) =>
      cycle.reports
        .filter(
          (report) =>
            report.kind === "member" &&
            report.authorId === input.userId &&
            !report.hiddenFromAuthor,
        )
        .map((report) => ({
          id: report.id,
          title: memberReportTitle(me ? humanLabel(me) : report.title, cycle.year, cycle.week),
          status: report.status,
          unread: unreadMine.has(report.id),
          sourceTemplateId: report.sourceTemplateId,
          year: cycle.year,
          week: cycle.week,
        })),
    ),
    memberWeeks,
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
