import type { PrismaClient } from "#src/generated/prisma/client";

/** The Memory Agent is opt-in per Workspace (task #6). A suite that needs one is a Workspace that
 * switched the experiment on, and it says so where it creates the Workspace — the product then
 * plants the Agent exactly as it does for a Workspace a person switched it on for. */
export const MEMORY_AGENT_ON = { memoryAgent: true };

/** The default Agent is real fixture data; assert its membership instead of filtering it out. */
export async function defaultMemoryAgentId(db: PrismaClient, workspaceId: string) {
  return (
    await db.workspaceMemoryAgent.findUniqueOrThrow({
      where: { workspaceId },
      select: { agentId: true },
    })
  ).agentId;
}
