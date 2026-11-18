import type { TeamMemoryCommand, TeamMemoryResult } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { teamMemory } from "./composition.server";
import { TeamMemoryError } from "./memory";
import { memoryEvidenceLinks } from "./evidence-links.server";

export async function manageTeamMemory(
  db: PrismaClient,
  actor: { workspaceId: string; userId: string },
  command: TeamMemoryCommand,
) {
  try {
    const memory = teamMemory(db);
    let result: TeamMemoryResult;
    if ("requestId" in command) {
      if (command.reviewToken) throw new TeamMemoryError("invalid");
      const review = await memory.execute(actor, command);
      result =
        review.status === "review_required"
          ? await memory.execute(actor, { ...command, reviewToken: review.reviewToken! })
          : review;
    } else result = await memory.execute(actor, command);
    const userIds = [
      ...new Set(
        result.entries
          .flatMap((entry) => [entry.authorUserId, entry.change?.actorUserId])
          .filter((id): id is string => !!id),
      ),
    ];
    const agentIds = [
      ...new Set(
        result.entries
          .flatMap((entry) => [entry.authorAgentId, entry.change?.actorAgentId])
          .filter((id): id is string => !!id),
      ),
    ];
    const projectIds = [
      ...new Set(result.entries.flatMap((entry) => (entry.projectId ? [entry.projectId] : []))),
    ];
    const [people, agents, projects, evidenceLinks] = await Promise.all([
      userIds.length
        ? db.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, displayName: true },
            take: 20,
          })
        : [],
      agentIds.length
        ? db.agent.findMany({
            where: { workspaceId: actor.workspaceId, id: { in: agentIds } },
            select: { id: true, displayName: true, name: true },
            take: 20,
          })
        : [],
      projectIds.length
        ? db.project.findMany({
            where: { workspaceId: actor.workspaceId, id: { in: projectIds } },
            select: { id: true, name: true },
            take: 10,
          })
        : [],
      command.operation === "get"
        ? memoryEvidenceLinks(
            db,
            actor.workspaceId,
            result.entries.flatMap(({ evidence }) => evidence ?? []),
          )
        : {},
    ]);
    return {
      kind: "ready" as const,
      result,
      evidenceLinks,
      names: Object.fromEntries([
        ...people.map((person) => [person.id, humanLabel(person)]),
        ...agents.map((agent) => [agent.id, agent.displayName || agent.name]),
        ...projects.map((project) => [project.id, project.name]),
      ]),
    };
  } catch (error) {
    if (error instanceof TeamMemoryError) return { kind: "error" as const, error: error.code };
    throw error;
  }
}
