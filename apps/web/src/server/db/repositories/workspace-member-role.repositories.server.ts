import type { PrismaClient } from "#src/generated/prisma/client";
import { isWorkspaceMemberRole } from "#src/server/workspaces/member-role.server";

/** The member's role; `undefined` for a non-member or a stored role that is not a known one. */
export async function findWorkspaceMemberRole(
  db: Pick<PrismaClient, "workspaceMembership">,
  workspaceId: string,
  userId: string,
) {
  const row = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  return row && isWorkspaceMemberRole(row.role) ? row.role : undefined;
}
