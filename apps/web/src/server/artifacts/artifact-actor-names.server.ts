import type { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { APP_BOT_LOGO_SELECT, agentFaceUrl } from "#src/server/apps/app-logo.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

export const REMOVED_ACTOR = "someone removed";

export type ArtifactActorName = { kind: "user" | "agent"; name: string };

type NameDb = Pick<PrismaClient, "agent" | "user">;

type ActorIds = { userIds: Iterable<string>; agentIds: Iterable<string> };

const distinct = (ids: ActorIds) => ({
  agentIds: [...new Set(ids.agentIds)],
  userIds: [...new Set(ids.userIds)],
});

const agentName = (agent: { displayName: string | null; name: string }) =>
  agent.displayName || agent.name;

export async function actorNames(db: NameDb, workspaceId: string, ids: ActorIds) {
  const { agentIds, userIds } = distinct(ids);
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
    ...agents.map((agent) => [agent.id, agentName(agent)] as const),
    ...users.map((user) => [user.id, humanLabel(user)] as const),
  ]);
}

export async function actorDirectory(db: NameDb, workspaceId: string, ids: ActorIds) {
  const { agentIds, userIds } = distinct(ids);
  const [agents, users] = await Promise.all([
    agentIds.length
      ? db.agent.findMany({
          where: { id: { in: agentIds }, workspaceId },
          select: {
            id: true,
            name: true,
            displayName: true,
            avatarMascot: true,
            appBot: APP_BOT_LOGO_SELECT,
          },
        })
      : [],
    userIds.length
      ? db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true, avatarObjectKey: true },
        })
      : [],
  ]);
  return {
    names: new Map<string, string>([
      ...agents.map((agent) => [agent.id, agentName(agent)] as const),
      ...users.map((user) => [user.id, humanLabel(user)] as const),
    ]),
    faces: new Map<string, string>([
      ...agents.map((agent) => [agent.id, agentFaceUrl(agent)] as const),
      ...users.map(
        (user) =>
          [user.id, workspaceUserAvatarUrl(workspaceId, user.id, user.avatarObjectKey)] as const,
      ),
    ]),
  };
}

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
