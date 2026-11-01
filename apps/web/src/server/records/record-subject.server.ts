import { humanLabel } from "#src/lib/human-label";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  isAssignmentUnread,
  memberReportTitle,
  reportBodyRestoreView,
  reportContentForAuthor,
  reportContentForRecipient,
  type ReportContent,
} from "#src/features/records/records-content";
import { canEditWeeklyReportContent } from "./weekly-report-editability.server";
import { canReadReport } from "./report-readers.server";
import { REPORT_PERSON_SELECT, reportPersonView } from "./record-member-weeks.server";
import { recordDistribution } from "./record-distribution.server";
import type { WeeklyReportNotifier } from "./weekly-report-distribution.server";
import { requireMembership } from "./record-catalog-access.server";
import { asReportContent } from "./record-content-coercion.server";

type Db = PrismaClient;

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

export function recordSubject(db: Db, notifier?: WeeklyReportNotifier) {
  async function getSubject(input: { workspaceId: string; userId: string; id: string }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
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
      if (!(await canReadReport(db, input.workspaceId, access, input.userId)))
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
          ? await db.weeklyReport.count({
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
              await db.weeklyReport.findMany({
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
              ? await recordDistribution(db, notifier).canSendWeeklyAssignments({
                  workspaceId: input.workspaceId,
                  userId: input.userId,
                  reportId: report.id,
                })
              : false,
          sendSchedule:
            report.kind === "template" && surface === "format"
              ? (
                  await recordDistribution(db, notifier).loadFormatSendState({
                    workspaceId: input.workspaceId,
                    userId: input.userId,
                    reportId: report.id,
                  })
                ).schedule
              : undefined,
          favorited:
            report.kind === "member"
              ? Boolean(
                  await db.weeklyReportFavorite.findUnique({
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

    const note = await db.recordNote.findFirst({
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

  return { getSubject };
}
