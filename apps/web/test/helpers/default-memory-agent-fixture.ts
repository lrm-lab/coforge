import type { PrismaClient } from "#src/generated/prisma/client";
export const MEMORY_AGENT_ON = {};
export async function defaultMemoryAgentId(db: PrismaClient, workspaceId: string) {
  return (
    await db.workspaceMemoryAgent.findUniqueOrThrow({
      where: { workspaceId },
      select: { agentId: true },
    })
  ).agentId;
}
