import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";

// Run explicitly against a disposable PostgreSQL database, never production.
const connectionString = Bun.env.WEEKLY_REPORT_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Set WEEKLY_REPORT_TEST_DATABASE_URL to an isolated test database");

test("weekly_reports.status accepts only draft and submitted", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const user = await db.user.create({
    data: {
      displayName: `status-${crypto.randomUUID()}`,
      username: `status-${crypto.randomUUID()}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `status-${crypto.randomUUID()}`,
      name: "Status check",
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  const cycle = await db.weeklyReportCycle.create({
    data: {
      workspaceId: workspace.id,
      year: 2999,
      week: 1,
      title: "Status check week",
      createdById: user.id,
    },
  });
  const base = {
    workspaceId: workspace.id,
    cycleId: cycle.id,
    authorId: user.id,
    kind: "member",
    title: "Status check report",
    content: { body: "Body." },
  };
  // An async wrapper: PrismaPromise is a thenable, not a Promise, so
  // `expect(...).rejects` cannot observe its rejection directly.
  const create = (status: string) =>
    (async () => db.weeklyReport.create({ data: { ...base, status } }))();
  try {
    await create("draft");
    await create("submitted");
    // 'shared' was legal under the original CHECK until the 2026-11-08 data
    // normalization; the tightened constraint refuses it like any other value.
    await expect(create("shared")).rejects.toThrow(/weekly_reports_status_check/);
    await expect(create("archived")).rejects.toThrow(/weekly_reports_status_check/);
    await expect(
      (async () =>
        db.weeklyReport.updateMany({
          where: { cycleId: cycle.id, status: "draft" },
          data: { status: "archived" },
        }))(),
    ).rejects.toThrow(/weekly_reports_status_check/);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}, 30_000);
