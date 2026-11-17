import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import type { TeamMemoryCatalogCommand, TeamMemoryResult } from "@lrm/coforge-sdk/agent";
import { teamMemoryAccess } from "./team-memory-access.repositories.server";
import { escapeLike } from "./team-memory-projections.server";
import { TeamMemoryError, type TeamMemoryActor } from "#src/server/team-memory/memory";

type Project = { id: string; name: string; slug: string; description: string };
export async function teamMemoryCatalog(
  db: PrismaClient,
  actor: TeamMemoryActor,
  command: TeamMemoryCatalogCommand,
): Promise<TeamMemoryResult> {
  return db.$transaction(async (tx) => {
    await teamMemoryAccess(tx, actor, command.operation === "project-create");
    if (command.operation === "projects") {
      const offset = command.offset ?? 0;
      const projects = await tx.$queryRaw<Project[]>(
        Prisma.sql`SELECT id, name, slug, left(description, 2000) AS description FROM projects WHERE "workspaceId" = ${actor.workspaceId}::uuid ${command.query ? Prisma.sql`AND (name ILIKE ${`%${escapeLike(command.query)}%`} OR slug ILIKE ${`%${escapeLike(command.query)}%`})` : Prisma.empty} ORDER BY name ASC, id ASC LIMIT 21 OFFSET ${offset}`,
      );
      return {
        status: "ok",
        entries: [],
        projects: projects.slice(0, 20),
        ...(projects.length > 20 ? { nextOffset: offset + 20 } : {}),
      };
    }
    const project = await tx.project.upsert({
      where: { workspaceId_slug: { workspaceId: actor.workspaceId, slug: command.slug } },
      create: {
        workspaceId: actor.workspaceId,
        slug: command.slug,
        name: command.name,
        description: command.description,
      },
      update: {},
      select: { id: true, name: true, slug: true, description: true },
    });
    if (project.name !== command.name || project.description !== command.description)
      throw new TeamMemoryError("conflict");
    return { status: "ok", entries: [], projects: [project] };
  });
}
