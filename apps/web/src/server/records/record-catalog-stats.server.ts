import { humanLabel } from "#src/lib/human-label";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import {
  currentIsoWeek,
  normalizeReportContent,
  reportContentForRecipient,
} from "#src/features/records/records-content";
import { buildWeeklyReportHtml } from "./weekly-report-html.server";
import { buildWeeklyReportPresentation } from "./weekly-report-presentation.server";
import { REPORT_PERSON_SELECT } from "./record-member-weeks.server";
import { requireMembership, requireWeeklyReportLeader } from "./record-catalog-access.server";

type Db = PrismaClient;

/** ISO (year, week) pairs that intersect the given calendar month. */
function isoWeeksTouchingMonth(year: number, month: number): Array<{ year: number; week: number }> {
  const result: Array<{ year: number; week: number }> = [];
  const days = new Date(year, month, 0).getDate();
  const seen = new Set<string>();
  for (let day = 1; day <= days; day += 1) {
    const iso = currentIsoWeek(new Date(year, month - 1, day));
    const key = `${iso.year}-${iso.week}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(iso);
  }
  return result;
}

export function recordStats(db: Db) {
  async function loadStats(input: {
    workspaceId: string;
    userId: string;
    year: number;
    month: number;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const members = await db.workspaceMembership.findMany({
      where: { workspaceId: input.workspaceId },
      include: {
        user: { select: REPORT_PERSON_SELECT },
      },
      orderBy: { createdAt: "asc" },
    });
    const monthWeekSet = [...isoWeeksTouchingMonth(input.year, input.month)];
    const cycles =
      monthWeekSet.length === 0
        ? []
        : await db.weeklyReportCycle.findMany({
            where: {
              workspaceId: input.workspaceId,
              OR: monthWeekSet.map(({ year, week }) => ({ year, week })),
            },
            include: {
              reports: {
                where: { kind: "member" },
                select: { authorId: true, status: true },
              },
            },
            orderBy: [{ year: "asc" }, { week: "asc" }],
          });
    const weeks = [...new Set(cycles.map((cycle) => cycle.week))].sort((a, b) => a - b);
    return {
      year: input.year,
      month: input.month,
      weeks,
      members: members.map((member) => {
        const byWeek = new Map(
          cycles.map((cycle) => {
            const report = cycle.reports.find((row) => row.authorId === member.userId);
            const submitted =
              report?.status === "submitted" || report?.status === "shared" ? true : false;
            return [cycle.week, submitted] as const;
          }),
        );
        const submittedCount = [...byWeek.values()].filter(Boolean).length;
        return {
          userId: member.userId,
          username: member.user.username,
          displayName: humanLabel(member.user),
          avatarUrl: workspaceUserAvatarUrl(
            input.workspaceId,
            member.userId,
            member.user.avatarObjectKey,
          ),
          submitted: submittedCount,
          unsubmitted: Math.max(0, weeks.length - submittedCount),
          weeks: Object.fromEntries(byWeek),
        };
      }),
    };
  }

  async function loadWeeklyReportDashboard(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const members = await db.workspaceMembership.findMany({
      where: { workspaceId: input.workspaceId },
      include: { user: { select: { id: true, username: true, displayName: true } } },
      orderBy: { createdAt: "asc" },
    });
    const cycles = await db.weeklyReportCycle.findMany({
      where: { workspaceId: input.workspaceId },
      orderBy: [{ year: "desc" }, { week: "desc" }],
      take: Math.min(Math.max(input.limit ?? 6, 2), 12),
      include: {
        reports: {
          where: { kind: "member", status: { in: ["submitted", "shared"] } },
          select: {
            id: true,
            authorId: true,
            content: true,
            status: true,
            submittedAt: true,
          },
        },
      },
    });
    const weeks = cycles.map((cycle) => ({
      year: cycle.year,
      week: cycle.week,
      title: cycle.title,
      submitted: cycle.reports.length,
      total: members.length,
      reports: cycle.reports.map((report) => {
        const author = members.find((member) => member.user.id === report.authorId)?.user;
        const content = reportContentForRecipient(normalizeReportContent(report.content));
        const summary = Object.values(content.tabs ?? {})
          .map((tab) => tab.markdown.trim())
          .find(Boolean);
        return {
          id: report.id,
          authorId: report.authorId,
          displayName: author ? humanLabel(author) : "Unknown member",
          summary: summary ? summary.slice(0, 280) : "",
          status: report.status,
          submittedAt: report.submittedAt?.toISOString() ?? null,
        };
      }),
    }));
    return {
      weeks,
      members: members.map((member) => ({
        userId: member.user.id,
        displayName: humanLabel(member.user),
      })),
    };
  }

  async function weeklyReportPresentationInput(input: {
    workspaceId: string;
    userId: string;
    overviewReportId: string;
  }) {
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const overview = await db.weeklyReport.findFirst({
      where: {
        id: input.overviewReportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: {
        title: true,
        content: true,
        cycle: { select: { year: true, week: true } },
        submissions: {
          where: { kind: "member", status: { in: ["submitted", "shared"] } },
          orderBy: { createdAt: "asc" },
          select: {
            content: true,
            author: { select: { username: true, displayName: true } },
          },
        },
      },
    });
    if (!overview) throw new AppError("NOT_FOUND");
    return {
      title: overview.title,
      period: `${overview.cycle.year} W${overview.cycle.week}`,
      summary: normalizeReportContent(overview.content).keyPointExtraction?.markdown,
      members: overview.submissions.map((submission) => {
        const content = reportContentForRecipient(normalizeReportContent(submission.content));
        return {
          displayName: humanLabel(submission.author),
          sections: Object.fromEntries(
            Object.entries(content.tabs ?? {}).map(([name, tab]) => [name, tab.markdown]),
          ),
        };
      }),
    };
  }

  /** Builds the checked-in Foundation Models weekly PPT for one Leader overview. */
  async function exportWeeklyReportPresentation(input: {
    workspaceId: string;
    userId: string;
    overviewReportId: string;
  }) {
    const overview = await weeklyReportPresentationInput(input);
    const bytes = await buildWeeklyReportPresentation(overview);
    return {
      bytes,
      fileName: `${overview.title.replace(/[\\/:*?"<>|]+/g, "-")}-${overview.period.replace(" ", "-")}.pptx`,
    };
  }

  /** Builds a self-contained HTML version of the same Leader overview. */
  async function exportWeeklyReportHtml(input: {
    workspaceId: string;
    userId: string;
    overviewReportId: string;
  }) {
    const overview = await weeklyReportPresentationInput(input);
    const html = buildWeeklyReportHtml(overview);
    return {
      bytes: new TextEncoder().encode(html),
      fileName: `${overview.title.replace(/[\\/:*?"<>|]+/g, "-")}-${overview.period.replace(" ", "-")}.html`,
    };
  }

  return {
    loadStats,
    loadWeeklyReportDashboard,
    exportWeeklyReportPresentation,
    exportWeeklyReportHtml,
  };
}
