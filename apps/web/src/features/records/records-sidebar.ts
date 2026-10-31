/** First-screen sidebar lists in weekly Records (T1/M1). */
export const RECORDS_SIDEBAR_PREVIEW_LIMIT = 3;

export type WeeklyLanding = { kind: "report"; id: string };

/** Newest member-week report target for `/records` weekly landing. */
export function latestWeeklyLanding(input: {
  memberWeeks: readonly {
    year: number;
    week: number;
    overviewReportId: string;
    submissions: readonly { id: string }[];
  }[];
}): WeeklyLanding | undefined {
  if (input.memberWeeks.length === 0) return undefined;
  const latest = [...input.memberWeeks].sort((left, right) =>
    left.year !== right.year ? right.year - left.year : right.week - left.week,
  )[0];
  if (!latest) return undefined;
  return { kind: "report", id: latest.submissions[0]?.id ?? latest.overviewReportId };
}

export function sidebarPreview<T>(
  items: readonly T[],
  expanded: boolean,
  limit = RECORDS_SIDEBAR_PREVIEW_LIMIT,
): { visible: T[]; hiddenCount: number } {
  if (expanded || items.length <= limit) {
    return { visible: [...items], hiddenCount: 0 };
  }
  return {
    visible: items.slice(0, limit) as T[],
    hiddenCount: items.length - limit,
  };
}

export type RecordsTab = "weekly" | "notes";

export function recordsTabSearch(tab: string | undefined): RecordsTab {
  return tab === "notes" ? "notes" : "weekly";
}

export function matchesQuery(text: string, query: string) {
  if (!query) return true;
  return text.toLowerCase().includes(query.toLowerCase());
}

/** Member-week rows (keyed `year-week`) whose title or submissions match the search query. */
export function filterMemberWeeks<
  S extends { title: string; author: { displayName: string } },
  W extends { year: number; week: number; title: string; submissions: S[] },
>(memberWeeks: readonly W[], query: string) {
  return memberWeeks
    .map((week) => ({
      ...week,
      key: `${week.year}-${week.week}`,
      submissions: week.submissions.filter(
        (submission) =>
          matchesQuery(submission.title, query) ||
          matchesQuery(submission.author.displayName, query) ||
          matchesQuery(week.title, query),
      ),
    }))
    .filter((week) => {
      if (!query) return true;
      return matchesQuery(week.title, query) || week.submissions.length > 0;
    });
}
