import type { PrismaClient } from "#src/generated/prisma/client";

type ResourceState = {
  role: string;
  memoryAgentId: string | null;
  hasMemoryProfile: boolean;
  weeklyAgentId: string | null;
  weeklyComputerId: string | null;
  platformComputerId: string | null;
};

/** One indexed read on the Workspace-open path, including the actor's membership. */
export async function workspaceResourceState(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; platformAgentId: string },
) {
  const rows = await db.$queryRaw<ResourceState[]>`
    SELECT member.role, memory.agent_id AS "memoryAgentId",
           (memory_profile.workspace_id IS NOT NULL) AS "hasMemoryProfile",
           weekly."agentId" AS "weeklyAgentId",
           weekly_agent."computerId" AS "weeklyComputerId",
           default_computer.id AS "platformComputerId"
    FROM workspace_memberships member
    LEFT JOIN workspace_memory_agents memory ON memory.workspace_id = member."workspaceId"
    LEFT JOIN workspace_memory_profiles memory_profile ON memory_profile.workspace_id = member."workspaceId"
    LEFT JOIN weekly_report_assistants weekly
      ON weekly."workspaceId" = member."workspaceId" AND weekly."userId" = member."userId"
    LEFT JOIN agents weekly_agent ON weekly_agent.id = weekly."agentId"
    LEFT JOIN agents platform_agent ON platform_agent.id = ${input.platformAgentId}::uuid
    LEFT JOIN computers default_computer
      ON default_computer.id = platform_agent."computerId"
      AND default_computer."ownerId" = member."userId"
      AND default_computer.kind = 'cloud' AND default_computer."cloudSlot" = 'default'
      AND default_computer."deletedAt" IS NULL
    WHERE member."workspaceId" = ${input.workspaceId}::uuid
      AND member."userId" = ${input.userId}::uuid
  `;
  return rows[0] ?? null;
}
