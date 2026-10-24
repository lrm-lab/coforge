import type { PrismaClient } from "#src/generated/prisma/client";

/** The default Agent is real fixture data; assert its membership instead of filtering it out. */
export async function defaultMemoryAgentId(db: PrismaClient, workspaceId: string) {
  return (
    await db.workspaceMemoryAgent.findUniqueOrThrow({
      where: { workspaceId },
      select: { agentId: true },
    })
  ).agentId;
}
