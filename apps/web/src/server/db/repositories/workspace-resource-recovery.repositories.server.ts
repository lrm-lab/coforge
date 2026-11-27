import type { PrismaClient } from "#src/generated/prisma/client";

type ResourceState = {
  role: string;
  experiments: unknown;
  weeklyAgentId: string | null;
  weeklyComputerId: string | null;
  platformComputerId: string | null;
};

export async function workspaceResourceState(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; platformAgentId: string },
) {
  const rows = await db.$queryRaw<ResourceState[]>`
    SELECT member.role,
           w.experiments,
           weekly."agentId" AS "weeklyAgentId",
           weekly_agent."computerId" AS "weeklyComputerId",
           default_computer.id AS "platformComputerId"
    FROM workspace_memberships member
    JOIN workspaces w ON w.id = member."workspaceId"
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
