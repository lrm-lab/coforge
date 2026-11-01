import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  currentIsoWeek,
  emptyReportContent,
  isValidTemplateName,
  memberWeekTitle,
  normalizeReportContent,
  type ReportContent,
} from "#src/features/records/records-content";
import {
  alignReportContentToSections,
  reportContentFromSections,
  sectionsFromReportContent,
  type TemplateOutlineSection,
} from "#src/features/records/template-outline-sections";
import { requireMembership } from "./record-catalog-access.server";
import { isValidIsoWeekNumber } from "#src/features/records/records-content";
import { zonedCalendarDate } from "#src/features/records/weekly-report-schedule-due";

export async function updateFormatReportMeta(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; reportId: string; title: string },
): Promise<{ id: string; title: string; year: number; week: number }> {
  // Only the author's live format can be renamed; a sent overview with member submissions is
  // historical and must keep its title.
  await requireMembership(db, input.workspaceId, input.userId);
  if (!isValidTemplateName(input.title)) throw new AppError("INVALID_INPUT");
  const title = input.title.trim();
  const report = await db.weeklyReport.findFirst({
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
  if (report.authorId !== input.userId || report.submissions.length > 0) {
    throw new AppError("ACCESS_DENIED");
  }
  if (title !== report.title) {
    await db.weeklyReport.update({ where: { id: report.id }, data: { title } });
    if (report.settingsId) {
      await db.weeklyReportTemplate.update({
        where: { id: report.settingsId },
        data: { name: title },
      });
    }
  }
  return { id: report.id, title, year: report.cycle.year, week: report.cycle.week };
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Find or create the Workspace ISO-week bucket for `(year, week)`. */
export async function ensureCycleAt(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    year: number;
    week: number;
  },
): Promise<{ id: string; year: number; week: number; title: string; created: boolean }> {
  await requireMembership(db, input.workspaceId, input.userId);
  if (!isValidIsoWeekNumber(input.week) || !Number.isInteger(input.year)) {
    throw new AppError("INVALID_INPUT");
  }
  const title = memberWeekTitle(input.year, input.week);
  const existing = await db.weeklyReportCycle.findUnique({
    where: {
      workspaceId_year_week: {
        workspaceId: input.workspaceId,
        year: input.year,
        week: input.week,
      },
    },
    select: { id: true, year: true, week: true, title: true },
  });
  if (existing) {
    return {
      id: existing.id,
      year: existing.year,
      week: existing.week,
      title: existing.title,
      created: false,
    };
  }
  const cycle = await db.weeklyReportCycle.create({
    data: {
      workspaceId: input.workspaceId,
      year: input.year,
      week: input.week,
      title,
      createdById: input.userId,
    },
    select: { id: true, year: true, week: true, title: true },
  });
  return { id: cycle.id, year: cycle.year, week: cycle.week, title: cycle.title, created: true };
}

export async function ensureCurrentCycle(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; now?: Date },
) {
  await requireMembership(db, input.workspaceId, input.userId);
  const { year, week } = currentIsoWeek(input.now ?? new Date());
  return ensureCycleAt(db, { workspaceId: input.workspaceId, userId: input.userId, year, week });
}

async function syncFormatReportToSections(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    sections: TemplateOutlineSection[];
  },
) {
  const report = await db.weeklyReport.findFirst({
    where: {
      id: input.reportId,
      workspaceId: input.workspaceId,
      authorId: input.userId,
      kind: "template",
      submissions: { none: { kind: "member" } },
    },
    select: { id: true, content: true },
  });
  if (!report) return;
  const next = alignReportContentToSections(normalizeReportContent(report.content), input.sections);
  await db.weeklyReport.update({
    where: { id: report.id },
    data: { content: next as unknown as Prisma.InputJsonValue },
  });
}

/** Move an unsent live format onto this week's cycle when the calendar advanced. */
export async function rebaseLiveFormatToCurrentWeek(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    cycle: { id: string; year: number; week: number };
    now: Date;
  },
): Promise<{ year: number; week: number }> {
  const current = currentIsoWeek(zonedCalendarDate(input.now));
  if (input.cycle.year === current.year && input.cycle.week === current.week) return current;
  const cycle = await ensureCycleAt(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    year: current.year,
    week: current.week,
  });
  if (input.cycle.id !== cycle.id) {
    await db.weeklyReport.update({
      where: { id: input.reportId },
      data: { cycleId: cycle.id },
    });
  }
  return { year: cycle.year, week: cycle.week };
}

/** Ensure a live format document for one applied settings stream (no assignments). */
export async function ensureFormatForSettings(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    settingsId: string;
    settingsName: string;
    now?: Date;
    sections?: TemplateOutlineSection[];
    alignContent?: boolean;
  },
): Promise<{ id: string }> {
  const linked = await db.weeklyReport.findFirst({
    where: {
      workspaceId: input.workspaceId,
      authorId: input.userId,
      kind: "template",
      settingsId: input.settingsId,
      submissions: { none: { kind: "member" } },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (linked) {
    if (input.alignContent && input.sections && input.sections.length > 0) {
      await syncFormatReportToSections(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        reportId: linked.id,
        sections: input.sections,
      });
    }
    const current = await db.weeklyReport.findFirst({
      where: { id: linked.id },
      select: { title: true, cycle: { select: { id: true, year: true, week: true } } },
    });
    if (current && current.title !== input.settingsName) {
      await db.weeklyReport.update({
        where: { id: linked.id },
        data: { title: input.settingsName },
      });
    }
    if (current?.cycle) {
      await rebaseLiveFormatToCurrentWeek(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        reportId: linked.id,
        cycle: current.cycle,
        now: input.now ?? new Date(),
      });
    }
    return linked;
  }

  const orphan = await db.weeklyReport.findFirst({
    where: {
      workspaceId: input.workspaceId,
      authorId: input.userId,
      kind: "template",
      settingsId: null,
      submissions: { none: { kind: "member" } },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, cycle: { select: { id: true, year: true, week: true } } },
  });
  if (orphan) {
    await db.weeklyReport.update({
      where: { id: orphan.id },
      data: { settingsId: input.settingsId, title: input.settingsName },
    });
    if (input.alignContent && input.sections && input.sections.length > 0) {
      await syncFormatReportToSections(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        reportId: orphan.id,
        sections: input.sections,
      });
    }
    await rebaseLiveFormatToCurrentWeek(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: orphan.id,
      cycle: orphan.cycle,
      now: input.now ?? new Date(),
    });
    return orphan;
  }

  const cycle = await ensureCycleAt(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    ...currentIsoWeek(input.now ?? new Date()),
  });
  const baseContent =
    input.sections && input.sections.length > 0
      ? reportContentFromSections(input.sections)
      : emptyReportContent();
  const prior = await db.weeklyReport.findFirst({
    where: {
      workspaceId: input.workspaceId,
      authorId: input.userId,
      kind: "template",
      settingsId: input.settingsId,
    },
    orderBy: { updatedAt: "desc" },
    select: { content: true },
  });
  const priorPrompts = prior ? normalizeReportContent(prior.content).keyPointPrompts : undefined;
  const content = priorPrompts ? { ...baseContent, keyPointPrompts: priorPrompts } : baseContent;
  return db.weeklyReport.create({
    data: {
      workspaceId: input.workspaceId,
      cycleId: cycle.id,
      authorId: input.userId,
      settingsId: input.settingsId,
      kind: "template",
      title: input.settingsName,
      status: "draft",
      content: content as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
}

export async function syncSettingsOutlineFromFormat(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; settingsId: string; content: ReportContent },
) {
  const settings = await db.weeklyReportTemplate.findFirst({
    where: { id: input.settingsId, workspaceId: input.workspaceId, ownerId: input.userId },
    select: { id: true },
  });
  if (!settings) return;
  await db.weeklyReportTemplate.update({
    where: { id: settings.id },
    data: {
      dimensions: sectionsFromReportContent(input.content) as unknown as Prisma.InputJsonValue,
      mainTitles: [],
    },
  });
}
