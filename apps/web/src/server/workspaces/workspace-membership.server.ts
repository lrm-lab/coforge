import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { WorkspaceMemberRole } from "./member-role.server";

type MembershipDb = Pick<PrismaClient, "workspaceMembership">;

/** Refuses (`ACCESS_DENIED`) a user who is not a member of the Workspace. */
export async function requireWorkspaceMember(
  db: MembershipDb,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { userId: true },
  });
  if (!membership) throw new AppError("ACCESS_DENIED");
}

/** The actor's Workspace role; ACCESS_DENIED when the user is not a member. */
export async function workspaceMemberRole(
  db: MembershipDb,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberRole> {
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) throw new AppError("ACCESS_DENIED");
  return membership.role as WorkspaceMemberRole;
}
