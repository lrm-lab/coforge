import type { PrismaClient } from "#src/generated/prisma/client";
import { isElevatedServerRole } from "#src/server/workspaces/member-role.server";

export type ExternalAgentManagerAccess =
  | {
      ok: true;
      agent: { hosting: string; deletedAt: Date | null; stoppedAt: Date | null };
    }
  | { ok: false };

export async function externalAgentManagerAccess(
  db: Pick<PrismaClient, "agent" | "workspaceMembership">,
  input: { userId: string; workspaceId: string; agentId: string },
): Promise<ExternalAgentManagerAccess> {
  const [agent, membership] = await Promise.all([
    db.agent.findFirst({
      where: { id: input.agentId, workspaceId: input.workspaceId },
      select: { ownerId: true, hosting: true, deletedAt: true, stoppedAt: true },
    }),
    db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
      select: { role: true },
    }),
  ]);
  if (!agent || !membership) return { ok: false };
  if (agent.ownerId !== input.userId && !isElevatedServerRole(membership.role))
    return { ok: false };
  return { ok: true, agent };
}
