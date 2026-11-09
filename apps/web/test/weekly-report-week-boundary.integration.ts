import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WeeklyReportWorkflow } from "#src/server/records/weekly-report-workflow.server";
import { distributeWeeklyReport } from "#src/server/records/weekly-report-distribution.server";
import { ensureCurrentCycle } from "#src/server/records/record-catalog-format.server";
import {
  currentScheduledIsoWeek,
  isoWeekOfDate,
} from "#src/features/records/weekly-report-schedule-due";

// Run explicitly against a disposable PostgreSQL database, never production.
const connectionString = Bun.env.WEEKLY_REPORT_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Set WEEKLY_REPORT_TEST_DATABASE_URL to an isolated test database");

test("a send across the schedule-week boundary still clears the live format's send stamp", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const owner = await db.user.create({
    data: { displayName: `boundary-owner-${suffix}`, username: `boundary-owner-${suffix}` },
  });
  const member = await db.user.create({
    data: { displayName: `boundary-member-${suffix}`, username: `boundary-member-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `boundary-${suffix}`,
      name: "Week boundary",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const actor = { workspaceId: workspace.id, userId: owner.id };
  const workflow = new WeeklyReportWorkflow(db, {
    notify: async () => ({ status: "notified" }),
  });
  // Sends target the Asia/Shanghai ISO week, but ensureCurrentCycle used the
  // server-local week: on a UTC host, 2026-11-08T20:00Z is still week 45 while
  // Shanghai is already Monday of week 46, so a stamp keyed to the cycle week
  // missed the send's strip and `schedule` survived into stored content.
  const previousTz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const configured = (await workflow.execute(actor, {
      type: "configure",
      requestId: crypto.randomUUID(),
      name: "Boundary Weekly",
      sections: [{ title: "Summary", children: [] }],
      allMembers: false,
      recipientUserIds: [member.id],
      scheduleEnabled: false,
      sendWeekday: 5,
      sendTime: "15:00",
    })) as { id: string };
    const boundaryNow = new Date("2026-11-08T20:00:00Z");
    const scheduleWeek = currentScheduledIsoWeek(boundaryNow);
    expect(isoWeekOfDate(boundaryNow)).not.toEqual(scheduleWeek);
    const cycle = await ensureCurrentCycle(db, { ...actor, now: boundaryNow });
    expect({ year: cycle.year, week: cycle.week }).toEqual(scheduleWeek);
    const liveFormat = await db.weeklyReport.create({
      data: {
        workspaceId: actor.workspaceId,
        authorId: actor.userId,
        cycleId: cycle.id,
        settingsId: configured.id,
        kind: "template",
        title: "Live format",
        content: {
          tabs: { Summary: { markdown: "Boundary body." } },
          schedule: {
            cancelledYear: cycle.year,
            cancelledWeek: cycle.week,
            dismissSend: true,
          },
        },
      },
    });
    const sent = await distributeWeeklyReport(
      db,
      { ...actor, templateId: configured.id, now: boundaryNow },
      { notify: async () => ({ status: "notified" }) },
    );
    expect({ year: sent.year, week: sent.week }).toEqual(scheduleWeek);
    expect(
      (await db.weeklyReport.findUniqueOrThrow({ where: { id: liveFormat.id } })).content,
    ).not.toHaveProperty("schedule");
    expect(
      (await db.weeklyReport.findUniqueOrThrow({ where: { id: sent.parentId } })).content,
    ).not.toHaveProperty("schedule");
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: member.id } });
    await db.user.delete({ where: { id: owner.id } });
    await db.$disconnect();
  }
}, 30_000);
