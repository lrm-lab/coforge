import type { PrismaClient } from "#src/generated/prisma/client";

/** What decides who may read a report. */
export type ReportAccess = {
  id: string;
  kind: string;
  authorId: string;
  hiddenFromAuthor: boolean;
  /** Who sent the template a member report was assigned from; null for any other report. */
  sourceTemplateAuthorId: string | null;
};

/** Who may read a report, as data: its named readers, one person never a reader whatever else
 * holds, and where the rest come from. `"workspace"`: every member. */
type ReaderRule =
  | "workspace"
  | {
      readers: string[];
      excluded?: string;
      /** And the author of every member report assigned from this template. */
      assigneesOf?: string;
      /** And whoever favorited this report. */
      favoritersOf?: string;
    };

/**
 * The one rule a read of a report (`getSubject`) and a realtime signal about it both follow:
 * - a template (a Leader's overview): its author, and every member it was assigned to;
 * - a member report: its author unless it is hidden from them, the Leader who sent its template,
 *   and whoever favorited it;
 * - any other report: every member of the Workspace.
 */
function readerRule(report: ReportAccess): ReaderRule {
  if (report.kind === "template") return { readers: [report.authorId], assigneesOf: report.id };
  if (report.kind !== "member") return "workspace";
  return {
    readers: report.sourceTemplateAuthorId
      ? [report.authorId, report.sourceTemplateAuthorId]
      : [report.authorId],
    excluded: report.hiddenFromAuthor ? report.authorId : undefined,
    favoritersOf: report.id,
  };
}

/** Whether `userId` may read the report, asking the database only for that one person. */
export async function canReadReport(
  db: PrismaClient,
  workspaceId: string,
  report: ReportAccess,
  userId: string,
): Promise<boolean> {
  const rule = readerRule(report);
  if (rule === "workspace") return true;
  if (userId === rule.excluded) return false;
  if (rule.readers.includes(userId)) return true;
  if (rule.assigneesOf) {
    const assignment = await db.weeklyReport.findFirst({
      where: { workspaceId, sourceTemplateId: rule.assigneesOf, kind: "member", authorId: userId },
      select: { id: true },
    });
    if (assignment) return true;
  }
  if (rule.favoritersOf) {
    const favorite = await db.weeklyReportFavorite.findUnique({
      where: { userId_reportId: { userId, reportId: rule.favoritersOf } },
      select: { reportId: true },
    });
    if (favorite) return true;
  }
  return false;
}

/** Everyone who may read the report: the people its rule names, or every member of the
 * Workspace. */
export async function reportReaders(
  db: PrismaClient,
  workspaceId: string,
  report: ReportAccess,
): Promise<ReadonlySet<string>> {
  const rule = readerRule(report);
  if (rule === "workspace") {
    const members = await db.workspaceMembership.findMany({
      where: { workspaceId },
      select: { userId: true },
    });
    return new Set(members.map((member) => member.userId));
  }
  const [assignees, favoriters] = await Promise.all([
    rule.assigneesOf
      ? db.weeklyReport.findMany({
          where: { workspaceId, sourceTemplateId: rule.assigneesOf, kind: "member" },
          select: { authorId: true },
        })
      : [],
    rule.favoritersOf
      ? db.weeklyReportFavorite.findMany({
          where: { reportId: rule.favoritersOf },
          select: { userId: true },
        })
      : [],
  ]);
  const readers = new Set([
    ...rule.readers,
    ...assignees.map((assignment) => assignment.authorId),
    ...favoriters.map((favorite) => favorite.userId),
  ]);
  if (rule.excluded) readers.delete(rule.excluded);
  return readers;
}
