import { expect, test } from "bun:test";

import type { PrismaClient } from "#src/generated/prisma/client";
import { filterMemberWeeks } from "#src/features/records/records-sidebar";
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
