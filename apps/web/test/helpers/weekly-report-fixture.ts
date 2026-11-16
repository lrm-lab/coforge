import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

const yearNoRealCycleUses = 2900 + (process.pid % 90);

export async function seedWeeklyReport(
  databaseUrl: string,
  {
    week,
    kind = "member",
    title,
    content,
  }: {
    week: number;
    kind?: "member" | "template";
    title: string;
    content: Prisma.InputJsonValue;
  },
) {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const cycle = await db.weeklyReportCycle.create({
    data: {
      workspaceId,
      year: yearNoRealCycleUses,
      week,
      title: "E2E week",
      createdById: DEV_BROWSER_USER.id,
    },
  });
  const data = {
    workspaceId,
    cycleId: cycle.id,
    authorId: DEV_BROWSER_USER.id,
    kind,
    title,
    content,
  };
  const report = await db.weeklyReport.create({ data });
  return {
    db,
    data,
    report,
    path: `/en/w/${workspace.slug}/records/${report.id}`,
    async remove() {
      await db.weeklyReport.deleteMany({ where: { id: report.id } }).catch(() => undefined);
      await db.weeklyReportCycle.deleteMany({ where: { id: cycle.id } }).catch(() => undefined);
      await db.$disconnect();
    },
  };
}
