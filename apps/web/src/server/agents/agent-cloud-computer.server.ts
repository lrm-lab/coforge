import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";

export async function isPrincipalOnCloudComputer(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string; computerId?: string },
): Promise<boolean> {
  if (principal.computerId !== undefined) {
    if (!principal.computerId) return false;
    const computer = await db.computer.findUnique({
      where: { id: principal.computerId },
      select: { kind: true },
    });
    return computer?.kind === "cloud";
  }
  const agent = await db.agent.findFirst({
    where: { id: principal.agentId, workspaceId: principal.workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { computer: { select: { kind: true } } },
  });
  return agent?.computer?.kind === "cloud";
}
