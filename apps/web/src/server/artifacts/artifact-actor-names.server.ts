import type { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";

/** What an actor shows as when its account or Agent no longer exists. */
export const REMOVED_ACTOR = "someone removed";

/** A person or an Agent as a reader sees them. */
export type ArtifactActorName = { kind: "user" | "agent"; name: string };

type NameDb = Pick<PrismaClient, "agent" | "user">;

/** Display names of some people and Agents of a Workspace, by id: an Agent's own name, a person's
 * `humanLabel`. An id with no row has no entry. */
export async function actorNames(
  db: NameDb,
  workspaceId: string,
  ids: { userIds: Iterable<string>; agentIds: Iterable<string> },
) {
  const agentIds = [...new Set(ids.agentIds)];
  const userIds = [...new Set(ids.userIds)];
  const [agents, users] = await Promise.all([
    agentIds.length
      ? db.agent.findMany({
          where: { id: { in: agentIds }, workspaceId },
          select: { id: true, name: true, displayName: true },
        })
      : [],
    userIds.length
      ? db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true },
        })
      : [],
  ]);
  return new Map<string, string>([
    ...agents.map((agent) => [agent.id, agent.displayName || agent.name] as const),
    ...users.map((user) => [user.id, humanLabel(user)] as const),
  ]);
}

/** One actor of a row by its two id columns (an Agent's wins), named from `names`; none at all
 * (a row whose author was removed) reads as removed. */
export function actorOf(
  names: ReadonlyMap<string, string>,
  columns: { userId: string | null; agentId: string | null },
): ArtifactActorName {
  if (columns.agentId) return { kind: "agent", name: names.get(columns.agentId) || REMOVED_ACTOR };
  return {
    kind: "user",
    name: (columns.userId && names.get(columns.userId)) || REMOVED_ACTOR,
  };
}
