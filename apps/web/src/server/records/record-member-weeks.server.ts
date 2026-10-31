import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { memberReportTitle, memberWeekTitle } from "#src/features/records/records-content";
import { splitWeeklyTemplateRoles } from "#src/features/records/weekly-send-window";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { isVisibleTemplateSubmission } from "./template-submission-visibility.server";

type Db = PrismaClient;

/**
 * How many member weeks the Records sidebar reads at a time, newest first. Two years of a
 * 20-person team was 737 KB read at once (task #366); older weeks are read when the list is
 * scrolled to its end.
 */
export const MEMBER_WEEKS_PAGE_SIZE = 12;

/** Where a page of member weeks ends: the next page holds only weeks older than this one. */
export type MemberWeekCursor = { year: number; week: number };

export const REPORT_PERSON_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarObjectKey: true,
} as const;

/** How a report's author is shown in Records lists. */
export function reportPersonView(
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

export type ReportPerson = ReturnType<typeof reportPersonView>;

/** One week a Leader collected member reports in, and the sent reports listed under it. */
export type MemberWeek = {
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
    authorId: string;
  }>;
};

/** Member weeks, and each person their submissions name, once (`people[authorId]`). */
export type MemberWeeks = { memberWeeks: MemberWeek[]; people: Record<string, ReportPerson> };

/**
 * The cycles a Leader collected member reports in: those holding one of `userId`'s templates that
 * member reports were assigned from (an overview). Every one of them is a member week, so a page
 * of cycles is a page of weeks.
 */
function overviewCycles(workspaceId: string, userId: string) {
  return {
    workspaceId,
    reports: {
      some: { kind: "template", authorId: userId, submissions: { some: { kind: "member" } } },
    },
  };
}

async function readOverviewCycles(
  db: Db,
  input: { workspaceId: string; userId: string },
  where: Prisma.WeeklyReportCycleWhereInput,
  take?: number,
) {
  return db.weeklyReportCycle.findMany({
    where: { AND: [overviewCycles(input.workspaceId, input.userId), where] },
    orderBy: [{ year: "desc" }, { week: "desc" }],
    take,
    select: {
      id: true,
      year: true,
      week: true,
      reports: {
        // The viewer's templates, and the member reports assigned from them.
        where: {
          OR: [
            { kind: "template", authorId: input.userId },
            { kind: "member", sourceTemplate: { authorId: input.userId } },
          ],
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          kind: true,
          authorId: true,
          status: true,
          sourceTemplateId: true,
          submittedAt: true,
          createdAt: true,
          author: { select: REPORT_PERSON_SELECT },
        },
      },
    },
  });
}

type OverviewCycle = Awaited<ReturnType<typeof readOverviewCycles>>[number];

/**
 * The member weeks the cycles hold, newest first. A week's overview is the newest of the viewer's
 * templates there with member reports assigned; it lists every sent member report assigned from
 * any of them.
 */
export function buildMemberWeeks(
  workspaceId: string,
  userId: string,
  cycles: readonly OverviewCycle[],
): MemberWeeks {
  const templates = cycles
    .flatMap((cycle) =>
      cycle.reports
        .filter((report) => report.kind === "template" && report.authorId === userId)
        .map((report) => ({
          cycle,
          report,
          hasAssignments: cycle.reports.some(
            (candidate) => candidate.kind === "member" && candidate.sourceTemplateId === report.id,
          ),
        })),
    )
    .sort((left, right) => right.report.createdAt.getTime() - left.report.createdAt.getTime());
  const { overviews } = splitWeeklyTemplateRoles(templates);
  const weeks = new Map<string, MemberWeek>();
  const people: Record<string, ReportPerson> = {};
  for (const { cycle, report } of overviews) {
    const key = `${cycle.year}-${cycle.week}`;
    let week = weeks.get(key);
    if (!week) {
      week = {
        year: cycle.year,
        week: cycle.week,
        title: memberWeekTitle(cycle.year, cycle.week),
        cycleId: cycle.id,
        overviewReportId: report.id,
        submissions: [],
      };
      weeks.set(key, week);
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
      const author = candidate.author;
      people[author.id] ??= reportPersonView(workspaceId, author);
      week.submissions.push({
        id: candidate.id,
        title: memberReportTitle(people[author.id].displayName, cycle.year, cycle.week),
        status: candidate.status,
        submittedAt: candidate.submittedAt?.toISOString() ?? null,
        sourceTemplateId: candidate.sourceTemplateId,
        authorId: author.id,
      });
    }
  }
  const memberWeeks = [...weeks.values()].sort((left, right) =>
    left.year !== right.year ? right.year - left.year : right.week - left.week,
  );
  return { memberWeeks, people };
}

/**
 * One page of member weeks, newest first: the latest ones, or those older than `before`. `before`
 * in the answer is where the next page starts; null when there is none.
 */
export async function loadMemberWeeksPage(
  db: Db,
  input: { workspaceId: string; userId: string; before?: MemberWeekCursor },
): Promise<MemberWeeks & { before: MemberWeekCursor | null }> {
  const before = input.before;
  const cycles = await readOverviewCycles(
    db,
    input,
    before
      ? { OR: [{ year: { lt: before.year } }, { year: before.year, week: { lt: before.week } }] }
      : {},
    MEMBER_WEEKS_PAGE_SIZE + 1,
  );
  const page = cycles.slice(0, MEMBER_WEEKS_PAGE_SIZE);
  const last = page.at(-1);
  return {
    ...buildMemberWeeks(input.workspaceId, input.userId, page),
    before:
      cycles.length > MEMBER_WEEKS_PAGE_SIZE && last ? { year: last.year, week: last.week } : null,
  };
}

/** One member week, wherever it falls: a link to it opens it without paging back to it. */
export async function loadMemberWeek(
  db: Db,
  input: { workspaceId: string; userId: string; year: number; week: number },
): Promise<MemberWeeks> {
  const cycles = await readOverviewCycles(db, input, { year: input.year, week: input.week });
  return buildMemberWeeks(input.workspaceId, input.userId, cycles);
}

/** Every member week, for a search across all of them (`filterMemberWeeks`). */
export async function loadAllMemberWeeks(
  db: Db,
  input: { workspaceId: string; userId: string },
): Promise<MemberWeeks> {
  return buildMemberWeeks(input.workspaceId, input.userId, await readOverviewCycles(db, input, {}));
}
