import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { EXPERIMENTS } from "#src/server/experiments/experiments.server";
import { TeamMemoryError, type TeamMemoryActor } from "#src/server/team-memory/memory";

type Database = PrismaClient | Prisma.TransactionClient;

export async function teamMemoryAccess(
  db: Database,
  actor: TeamMemoryActor,
  lock = false,
): Promise<boolean> {
  if (actor.userId) {
    const rows = await db.$queryRaw<{ role: string; enabled: boolean }[]>(Prisma.sql`
      SELECT m.role, COALESCE(NULLIF(w.experiments->'teamMemory', 'null'::jsonb), ${JSON.stringify(EXPERIMENTS.teamMemory.defaultEnabled)}::jsonb) = 'true'::jsonb AS enabled
      FROM workspace_memberships m JOIN workspaces w ON w.id = m."workspaceId"
      WHERE m."workspaceId" = ${actor.workspaceId}::uuid AND m."userId" = ${actor.userId}::uuid
      ${lock ? Prisma.sql`FOR SHARE OF m, w` : Prisma.empty}`);
    if (!rows[0]) throw new TeamMemoryError("forbidden");
    if (!rows[0].enabled) throw new TeamMemoryError("disabled");
    return rows[0].role === "owner" || rows[0].role === "admin";
  }
  const rows = await db.$queryRaw<{ role: string; teamMemoryEnabled: boolean | null }[]>(Prisma.sql`
    SELECT a."role", COALESCE(NULLIF(w.experiments->'teamMemory', 'null'::jsonb),
      ${JSON.stringify(EXPERIMENTS.teamMemory.defaultEnabled)}::jsonb) = 'true'::jsonb AS "teamMemoryEnabled"
    FROM "agents" a JOIN "workspace_memberships" m
    ON m."workspaceId" = a."workspaceId" AND m."userId" = a."ownerId"
    JOIN "workspaces" w ON w.id = a."workspaceId"
    WHERE a."id" = ${actor.agentId}::uuid AND a."workspaceId" = ${actor.workspaceId}::uuid AND a."deletedAt" IS NULL
    ${lock ? Prisma.sql`FOR SHARE OF a, m, w` : Prisma.empty}`);
  if (!rows[0]) throw new TeamMemoryError("forbidden");
  if (!rows[0].teamMemoryEnabled) throw new TeamMemoryError("disabled");
  return rows[0].role === "owner" || rows[0].role === "admin";
}
