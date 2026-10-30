import type { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey, peopleDirectKey } from "#src/features/conversations/direct-key";
import type { ForwardTarget } from "#src/features/conversations/message-forward";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { humanLabel } from "#src/lib/human-label";
import { ACTIVE_AGENT_WHERE, ROSTER_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { directMessageAgentWhere } from "#src/server/agents/agent-visibility.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { visibleChannelWhere } from "./channel-read-access.server";

/** Round-robin over the lists, so a long run of one kind does not crowd the others out. */
function interleave<T>(lists: readonly (readonly T[])[], limit: number): T[] {
  const merged: T[] = [];
  for (let index = 0; merged.length < limit; index += 1) {
    const round = lists.flatMap((list) => (index < list.length ? [list[index]!] : []));
    if (!round.length) break;
    merged.push(...round.slice(0, limit - merged.length));
  }
  return merged;
}

/**
 * Where the viewer can forward a message, for a picker's search: channels (joined ones first),
 * members and Agents they may message, each with the direct conversation they already have. A
 * person is found by name, never by username. `joined` and `canSend` tell the picker what to ask
 * or disable, from the same rules a forward is checked by: an archived channel takes none, and a
 * channel the viewer has not joined is joined first, at their say-so.
 */
export async function searchForwardTargets(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; q: string; limit: number },
): Promise<ForwardTarget[]> {
  const { workspaceId, userId, limit } = input;
  const q = input.q.trim();
  await requireWorkspaceMember(db, workspaceId, userId);
  const named = q ? { contains: q, mode: "insensitive" as const } : undefined;
  const channelSelect = {
    id: true,
    channelName: true,
    archivedAt: true,
    members: { where: { userId, ...ACTIVE_MEMBER_WHERE }, select: { id: true }, take: 1 },
  } as const;
  const channelWhere = {
    ...visibleChannelWhere(workspaceId, { userId }),
    kind: null,
    channelName: named ?? { not: null },
  };
  const [joinedChannels, otherChannels, people, agents] = await Promise.all([
    db.conversation.findMany({
      where: { ...channelWhere, members: { some: { userId, ...ACTIVE_MEMBER_WHERE } } },
      orderBy: { channelName: "asc" },
      take: limit,
      select: channelSelect,
    }),
    db.conversation.findMany({
      where: { ...channelWhere, members: { none: { userId, ...ACTIVE_MEMBER_WHERE } } },
      orderBy: { channelName: "asc" },
      take: limit,
      select: channelSelect,
    }),
    db.workspaceMembership.findMany({
      where: { workspaceId, ...(named ? { user: { displayName: named } } : {}) },
      orderBy: { user: { displayName: "asc" } },
      take: limit,
      select: {
        user: { select: { id: true, displayName: true, avatarObjectKey: true } },
      },
    }),
    db.agent.findMany({
      where: {
        workspaceId,
        ...ACTIVE_AGENT_WHERE,
        AND: [
          ROSTER_AGENT_WHERE,
          directMessageAgentWhere(userId),
          ...(named ? [{ OR: [{ name: named }, { displayName: named }] }] : []),
        ],
      },
      orderBy: { name: "asc" },
      take: limit,
      select: { id: true, name: true, displayName: true, avatarMascot: true },
    }),
  ]);
  const directKeys = [
    ...people.map(({ user }) => peopleDirectKey(userId, user.id)),
    ...agents.map((agent) => agentDirectKey(userId, agent.id)),
  ];
  const directs = directKeys.length
    ? await db.conversation.findMany({
        where: { workspaceId, directKey: { in: directKeys } },
        select: { id: true, directKey: true },
      })
    : [];
  const directOf = new Map(directs.map((direct) => [direct.directKey, direct.id]));
  const channels = [...joinedChannels, ...otherChannels].map((channel): ForwardTarget => ({
    kind: "channel",
    conversationId: channel.id,
    name: channel.channelName!,
    joined: channel.members.length > 0,
    canSend: channel.archivedAt === null,
  }));
  const members = people.map(({ user }): ForwardTarget => {
    const conversationId = directOf.get(peopleDirectKey(userId, user.id));
    return {
      kind: "person",
      userId: user.id,
      name: humanLabel(user),
      avatarUrl: workspaceUserAvatarUrl(workspaceId, user.id, user.avatarObjectKey),
      ...(conversationId ? { conversationId } : {}),
      joined: true,
      canSend: true,
    };
  });
  const bots = agents.map((agent): ForwardTarget => {
    const conversationId = directOf.get(agentDirectKey(userId, agent.id));
    return {
      kind: "agent",
      agentId: agent.id,
      name: agent.displayName.trim() || agent.name,
      handle: agent.name,
      avatarUrl: agentAvatarUrl(agent.id, agent.avatarMascot),
      ...(conversationId ? { conversationId } : {}),
      joined: true,
      canSend: true,
    };
  });
  return interleave([channels, members, bots], limit);
}
