import { expect, test } from "bun:test";

import type { PrismaClient } from "#src/generated/prisma/client";
import {
  filterMemberWeeks,
  isSelectedMemberWeek,
  memberWeeksPreview,
  mergeMemberWeeks,
} from "#src/features/records/records-sidebar";
import {
  MEMBER_WEEKS_PAGE_SIZE,
  loadMemberWeeksPage,
} from "#src/server/records/record-member-weeks.server";

/**
 * Task #366: the Records sidebar reads member weeks a page at a time, newest first, and searches
 * every week on the server with the same filter it applies to the weeks it holds.
 */
function cycle(year: number, week: number) {
  const created = new Date(Date.UTC(year, 0, week * 7));
  const person = (id: string, name: string) => ({
    id,
    username: id,
    displayName: name,
    avatarObjectKey: null,
  });
  return {
    id: `cycle-${year}-${week}`,
    year,
    week,
    reports: [
      {
        id: `overview-${year}-${week}`,
        kind: "template",
        authorId: "leader",
        status: "draft",
        sourceTemplateId: null,
        submittedAt: null,
        createdAt: created,
        author: person("leader", "Leader"),
      },
      {
        id: `alice-${year}-${week}`,
        kind: "member",
        authorId: "alice",
        status: "submitted",
        sourceTemplateId: `overview-${year}-${week}`,
        submittedAt: created,
        createdAt: created,
        author: person("alice", "Alice"),
      },
    ],
  };
}

function cyclesDb(count: number) {
  const queries: Array<{ where: unknown; take?: number }> = [];
  const all = Array.from({ length: count }, (_, index) => cycle(2026, 40 - index));
  const db = {
    weeklyReportCycle: {
      findMany: async (query: { where: unknown; take?: number }) => {
        queries.push(query);
        return all.slice(0, query.take);
      },
    },
  } as unknown as PrismaClient;
  return { db, queries };
}

test("a page holds the newest weeks and says where the next one starts", async () => {
  const { db, queries } = cyclesDb(MEMBER_WEEKS_PAGE_SIZE + 3);
  const page = await loadMemberWeeksPage(db, { workspaceId: "w", userId: "leader" });
  expect(page.memberWeeks.map((week) => week.week)).toEqual(
    Array.from({ length: MEMBER_WEEKS_PAGE_SIZE }, (_, index) => 40 - index),
  );
  expect(page.before).toEqual({ year: 2026, week: 40 - MEMBER_WEEKS_PAGE_SIZE + 1 });
  // One more than a page is asked for, to know whether another page follows.
  expect(queries[0]!.take).toBe(MEMBER_WEEKS_PAGE_SIZE + 1);
  expect(page.people).toEqual({ alice: expect.objectContaining({ displayName: "Alice" }) });
  expect(page.memberWeeks[0]!.submissions[0]).toMatchObject({
    id: "alice-2026-40",
    authorId: "alice",
  });
});

test("the last page says no page follows, and an older page reads only older weeks", async () => {
  const { db, queries } = cyclesDb(MEMBER_WEEKS_PAGE_SIZE);
  const page = await loadMemberWeeksPage(db, {
    workspaceId: "w",
    userId: "leader",
    before: { year: 2026, week: 30 },
  });
  expect(page.before).toBeNull();
  expect(JSON.stringify(queries[0]!.where)).toContain(
    JSON.stringify({
      OR: [{ year: { lt: 2026 } }, { year: 2026, week: { lt: 30 } }],
    }),
  );
});

test("a search matches a week, a report title or its author's name", () => {
  const weeks = [
    {
      year: 2026,
      week: 40,
      title: "2026 W40 工作周报",
      submissions: [
        { id: "a", title: "Alice 2026 W40 工作周报", authorId: "alice" },
        { id: "b", title: "Bob 2026 W40 工作周报", authorId: "bob" },
      ],
    },
    {
      year: 2024,
      week: 2,
      title: "2024 W2 工作周报",
      submissions: [{ id: "c", title: "Carol 2024 W2 工作周报", authorId: "carol" }],
    },
  ];
  const people = {
    alice: { displayName: "Alice" },
    bob: { displayName: "Bob" },
    carol: { displayName: "carol-nick" },
  };
  const ids = (query: string) =>
    filterMemberWeeks(weeks, query, people).map((week) => [
      week.key,
      week.submissions.map((row) => row.id),
    ]);
  expect(ids("bob")).toEqual([["2026-40", ["b"]]]);
  expect(ids("NICK")).toEqual([["2024-2", ["c"]]]);
  expect(ids("2024 W2")).toEqual([["2024-2", ["c"]]]);
  expect(ids("")).toEqual([
    ["2026-40", ["a", "b"]],
    ["2024-2", ["c"]],
  ]);
});

const week = (year: number, number: number, ids: string[] = []) => ({
  year,
  week: number,
  overviewReportId: `overview-${year}-${number}`,
  submissions: ids.map((id) => ({ id })),
});

test("a week read on its own and again by paging is listed once, where paging put it", () => {
  const firstPage = [week(2026, 40), week(2026, 39)];
  const olderPage = [week(2026, 38), week(2024, 10, ["paged"])];
  const pinned = [week(2024, 10, ["pinned"])];
  const merged = mergeMemberWeeks(firstPage, olderPage, pinned);
  expect(merged.map((row) => `${row.year}-${row.week}`)).toEqual([
    "2026-40",
    "2026-39",
    "2026-38",
    "2024-10",
  ]);
  expect(merged.at(-1)!.submissions).toEqual([{ id: "paged" }]);
  // Before paging reaches it, the pinned week is listed last.
  expect(mergeMemberWeeks(firstPage, pinned).map((row) => row.week)).toEqual([40, 39, 10]);
});

test("the week on screen stays listed when only the first few weeks are shown", () => {
  const weeks = [
    week(2026, 40),
    week(2026, 39),
    week(2026, 38),
    week(2026, 37),
    week(2024, 10, ["mine"]),
  ];
  const selected = (row: (typeof weeks)[number]) => isSelectedMemberWeek(row, "mine", undefined);
  const preview = memberWeeksPreview(weeks, false, selected);
  expect(preview.visible.map((row) => row.week)).toEqual([40, 39, 38, 10]);
  expect(preview.hiddenCount).toBe(1);
  // Shown all, or selected among the first few: the plain preview.
  expect(memberWeeksPreview(weeks, true, selected).visible).toHaveLength(5);
  expect(
    memberWeeksPreview(weeks, false, (row) => isSelectedMemberWeek(row, undefined, "2026-39")),
  ).toEqual({ visible: weeks.slice(0, 3), hiddenCount: 2 });
});
