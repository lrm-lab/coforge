import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { channelActorOf } from "#src/server/conversations/channel-actor.server";
import { resolveActorServerRole } from "#src/server/conversations/channel-authority.server";
import { isElevatedServerRole } from "#src/server/workspaces/member-role.server";

import { TASK_ASSIGNMENT_MANAGER_REQUIRED } from "#src/features/tasks/task-assignment";

export async function canAssignOther(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  actor: Parameters<typeof resolveActorServerRole>[2],
) {
  return isElevatedServerRole(await resolveActorServerRole(db, workspaceId, actor));
}

/** A Task assignment may affect someone else only through the actor's current server role. */
export async function assertCanAssignOther(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  member: { userId: string | null; agentId: string | null },
) {
  const actor = channelActorOf(member);
  if (!(await canAssignOther(db, workspaceId, actor)))
    throw new AppError("ACCESS_DENIED", { errorId: TASK_ASSIGNMENT_MANAGER_REQUIRED });
}
