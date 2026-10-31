import { expect, test } from "bun:test";

import type { PrismaClient } from "#src/generated/prisma/client";
import {
  canReadReport,
  reportReaders,
  type ReportAccess,
} from "#src/server/records/report-readers.server";

/**
 * Task #366: a realtime signal about a report goes to the people who may read it, by the same rule
 * a read follows. Both answers come from one rule, so they must agree for every person.
 */
const assignments = [
  { authorId: "alice", sourceTemplateId: "template" },
  { authorId: "bob", sourceTemplateId: "template" },
];
const favorites = [{ userId: "carol", reportId: "alice-report" }];
const people = ["leader", "alice", "bob", "carol", "dave"];
const db = {
  weeklyReport: {
    findFirst: async ({ where }: { where: { sourceTemplateId: string; authorId: string } }) =>
      assignments.find(
        (row) => row.sourceTemplateId === where.sourceTemplateId && row.authorId === where.authorId,
      ) ?? null,
    findMany: async ({ where }: { where: { sourceTemplateId: string } }) =>
      assignments.filter((row) => row.sourceTemplateId === where.sourceTemplateId),
  },
  weeklyReportFavorite: {
    findUnique: async ({
      where,
    }: {
      where: { userId_reportId: { userId: string; reportId: string } };
    }) =>
      favorites.find(
        (row) =>
          row.userId === where.userId_reportId.userId &&
          row.reportId === where.userId_reportId.reportId,
      ) ?? null,
    findMany: async ({ where }: { where: { reportId: string } }) =>
      favorites.filter((row) => row.reportId === where.reportId),
  },
  workspaceMembership: { findMany: async () => people.map((userId) => ({ userId })) },
} as unknown as PrismaClient;

async function whoCanRead(report: ReportAccess) {
  const one = await Promise.all(
    people.map(async (person) =>
      (await canReadReport(db, "workspace", report, person)) ? [person] : [],
    ),
  );
  const all = await reportReaders(db, "workspace", report);
  return { one: one.flat(), all: [...all].sort() };
}

test("a Leader's overview is read by the Leader and every member it was assigned to", async () => {
  const { one, all } = await whoCanRead({
    id: "template",
    kind: "template",
    authorId: "leader",
    hiddenFromAuthor: false,
    sourceTemplateAuthorId: null,
  });
  expect(one).toEqual(["leader", "alice", "bob"]);
  expect(all).toEqual(["alice", "bob", "leader"]);
});

test("a member report is read by its author, the Leader and whoever favorited it", async () => {
  const report = {
    id: "alice-report",
    kind: "member",
    authorId: "alice",
    hiddenFromAuthor: false,
    sourceTemplateAuthorId: "leader",
  };
  const shown = await whoCanRead(report);
  expect(shown.one).toEqual(["leader", "alice", "carol"]);
  expect(shown.all).toEqual(["alice", "carol", "leader"]);
  // A report hidden from its author is not theirs to read, whatever else holds.
  const hidden = await whoCanRead({ ...report, hiddenFromAuthor: true });
  expect(hidden.one).toEqual(["leader", "carol"]);
  expect(hidden.all).toEqual(["carol", "leader"]);
});

test("any other report is read by every member", async () => {
  const { one, all } = await whoCanRead({
    id: "other",
    kind: "note",
    authorId: "alice",
    hiddenFromAuthor: false,
    sourceTemplateAuthorId: null,
  });
  expect(one).toEqual(people);
  expect(all).toEqual([...people].sort());
});
