import type { Prisma, PrismaClient } from "#src/generated/prisma/client";

export async function enableWeeklyReportsForTest(db: PrismaClient, workspaceId: string) {
  const current = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { experiments: true },
  });
  const base =
    current.experiments &&
    typeof current.experiments === "object" &&
    !Array.isArray(current.experiments)
      ? (current.experiments as Record<string, unknown>)
      : {};
  await db.workspace.update({
    where: { id: workspaceId },
    data: { experiments: { ...base, weeklyReports: true } as Prisma.InputJsonValue },
  });
  return {
    restore: () =>
      db.workspace
        .update({
          where: { id: workspaceId },
          data: { experiments: (current.experiments ?? null) as Prisma.InputJsonValue },
        })
        .catch(() => undefined),
  };
}
