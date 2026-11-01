import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  normalizeReportContent,
  withAutoSendCancelled,
} from "#src/features/records/records-content";
import { requireMembership } from "./record-catalog-access.server";

type Db = PrismaClient;

export function recordReportManagement(db: Db) {
  async function deleteMemberReport(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
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
      await db.weeklyReport.update({ where: { id: report.id }, data: { hiddenFromAuthor: true } });
      return { ok: true as const };
    }
    await db.weeklyReport.delete({ where: { id: report.id } });
    return { ok: true as const };
  }

  async function setReportFavorite(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    favorited: boolean;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId, kind: "member" },
      select: { id: true, authorId: true, sourceTemplate: { select: { authorId: true } } },
    });
    if (!report) throw new AppError("NOT_FOUND");
    const canAccess =
      report.authorId === input.userId || report.sourceTemplate?.authorId === input.userId;
    if (!canAccess) {
      const favorite = await db.weeklyReportFavorite.findUnique({
        where: { userId_reportId: { userId: input.userId, reportId: report.id } },
        select: { reportId: true },
      });
      if (!favorite) throw new AppError("NOT_FOUND");
    }
    if (input.favorited) {
      await db.weeklyReportFavorite.upsert({
        where: { userId_reportId: { userId: input.userId, reportId: report.id } },
        create: { userId: input.userId, reportId: report.id },
        update: {},
      });
      return { favorited: true as const };
    }
    await db.weeklyReportFavorite.deleteMany({
      where: { userId: input.userId, reportId: report.id },
    });
    return { favorited: false as const };
  }

  async function cancelScheduledSendForWeek(input: {
    workspaceId: string;
    userId: string;
    settingsId: string | null;
    year: number;
    week: number;
  }) {
    if (!input.settingsId) return;
    const liveFormat = await db.weeklyReport.findFirst({
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
    const next = withAutoSendCancelled(
      normalizeReportContent(liveFormat.content),
      input.year,
      input.week,
    );
    await db.weeklyReport.update({
      where: { id: liveFormat.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
    });
  }

  async function deleteOverviewReport(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const overview = await db.weeklyReport.findFirst({
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
    await db.$transaction(async (tx) => {
      await tx.weeklyReport.updateMany({
        where: { workspaceId: input.workspaceId, kind: "member", sourceTemplateId: overview.id },
        data: { sourceTemplateId: null },
      });
      await tx.weeklyReport.deleteMany({ where: { id: { in: [overview.id] } } });
      const remaining = await tx.weeklyReport.count({
        where: { workspaceId: input.workspaceId, cycleId: overview.cycleId },
      });
      if (remaining === 0) await tx.weeklyReportCycle.delete({ where: { id: overview.cycleId } });
    });
    await cancelScheduledSendForWeek({
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: overview.settingsId,
      year: overview.cycle.year,
      week: overview.cycle.week,
    });
    return { ok: true as const };
  }

  async function deleteMemberWeek(input: { workspaceId: string; userId: string; cycleId: string }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const cycle = await db.weeklyReportCycle.findFirst({
      where: { id: input.cycleId, workspaceId: input.workspaceId },
      select: { id: true, year: true, week: true },
    });
    if (!cycle) throw new AppError("NOT_FOUND");
    const myTemplates = await db.weeklyReport.findMany({
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
        myTemplates.map((row) => row.settingsId).filter((id): id is string => Boolean(id)),
      ),
    ];
    const submissions = await db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        kind: "member",
        sourceTemplateId: { in: templateIds },
      },
      select: { id: true },
    });
    const reportIds = [...submissions.map((row) => row.id), ...templateIds];
    await db.$transaction(async (tx) => {
      if (reportIds.length > 0)
        await tx.weeklyReport.deleteMany({ where: { id: { in: reportIds } } });
      const remaining = await tx.weeklyReport.count({
        where: { workspaceId: input.workspaceId, cycleId: cycle.id },
      });
      if (remaining === 0) await tx.weeklyReportCycle.delete({ where: { id: cycle.id } });
    });
    for (const settingsId of settingsIds) {
      await cancelScheduledSendForWeek({
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId,
        year: cycle.year,
        week: cycle.week,
      });
    }
    return { ok: true as const };
  }

  return { deleteMemberReport, setReportFavorite, deleteOverviewReport, deleteMemberWeek };
}
