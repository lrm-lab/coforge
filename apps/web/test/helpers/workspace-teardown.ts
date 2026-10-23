import type { PrismaClient } from "#src/generated/prisma/client";

/** Removes a test's Workspace and people, then closes its database client. */
export async function teardown(db: PrismaClient, workspaceId: string, userIds: string[]) {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
}
