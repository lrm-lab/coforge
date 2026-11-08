import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { recordReportContent } from "#src/server/records/record-report-content.server";

const USER = "member-1";
const WORKSPACE = "workspace-1";
const UPDATED_AT = new Date("2026-11-01T09:00:00.000Z");

function memberReport(overrides: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    authorId: USER,
    kind: "member",
    status: "draft",
    hiddenFromAuthor: false,
    settingsId: null,
    sourceTemplateId: null,
    content: { tabs: { Summary: { markdown: "stored body" } } },
    cycle: { year: 2026, week: 45 },
    submissions: [],
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

/**
 * A Prisma stand-in for saveReportContent's member-report path. `weeklyReport.update`
 * honours the extended-where `updatedAt` the version guard adds, answering P2025 the way
 * PostgreSQL does when the row moved since the client loaded it.
 */
function contentDb(report: ReturnType<typeof memberReport>) {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReport: {
      findFirst: async () => report,
      update: async (query: {
        where: { id: string; updatedAt?: Date };
        data: Record<string, unknown>;
      }) => {
        updates.push(query);
        if (
          query.where.updatedAt !== undefined &&
          query.where.updatedAt.getTime() !== report.updatedAt.getTime()
        ) {
          throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        }
        return {
          id: report.id,
          status: (query.data.status as string | undefined) ?? report.status,
          updatedAt: new Date("2026-11-02T09:00:00.000Z"),
        };
      },
    },
    recordComment: { create: async () => ({ id: "comment-1" }) },
  } as unknown as PrismaClient;
  return { db, updates };
}

const save = (db: PrismaClient, extra: Record<string, unknown> = {}) =>
  recordReportContent(db).saveReportContent({
    workspaceId: WORKSPACE,
    userId: USER,
    reportId: "report-1",
    content: { tabs: { Summary: { markdown: "edited body" } } },
    ...extra,
  });

test("a draft member report submits and stamps submittedAt", async () => {
  const { db, updates } = contentDb(memberReport());
  const result = await save(db, { status: "submitted" });
  expect(result.status).toBe("submitted");
  expect(updates[0]?.data).toMatchObject({ status: "submitted" });
  expect(updates[0]?.data.submittedAt).toBeInstanceOf(Date);
});

test("an already submitted member report may submit again", async () => {
  const { db } = contentDb(memberReport({ status: "submitted" }));
  const result = await save(db, { status: "submitted" });
  expect(result.status).toBe("submitted");
});

test("a submitted report cannot be moved back to draft or shared", async () => {
  const { db, updates } = contentDb(memberReport({ status: "submitted" }));
  // A caller bypassing the types still cannot rewrite the status: only "submitted"
  // is a transition request, anything else is refused outright.
  for (const status of ["draft", "shared"]) {
    await expect(save(db, { status: status as "submitted" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  }
  expect(updates).toHaveLength(0);
});

test("a template report refuses a submit transition", async () => {
  const { db, updates } = contentDb(memberReport({ kind: "template", authorId: USER }));
  await expect(save(db, { status: "submitted" })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(updates).toHaveLength(0);
});

test("a save based on a stale updatedAt conflicts instead of overwriting", async () => {
  const { db } = contentDb(memberReport());
  await expect(save(db, { baseUpdatedAt: "2026-10-31T09:00:00.000Z" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
});

test("a save based on the current updatedAt writes through", async () => {
  const { db, updates } = contentDb(memberReport());
  const result = await save(db, { baseUpdatedAt: UPDATED_AT.toISOString() });
  expect(result.status).toBe("draft");
  expect(updates[0]?.where.updatedAt).toEqual(UPDATED_AT);
});

test("a save without a base version keeps the unguarded path", async () => {
  const { db, updates } = contentDb(memberReport());
  await save(db);
  expect(updates[0]?.where.updatedAt).toBeUndefined();
});

test("a malformed base version is refused before any write", async () => {
  const { db, updates } = contentDb(memberReport());
  await expect(save(db, { baseUpdatedAt: "not-a-date" })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(updates).toHaveLength(0);
});
