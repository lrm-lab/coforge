import type { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey, peopleDirectKey } from "#src/features/conversations/direct-key";
import type { ForwardTarget } from "#src/features/conversations/message-forward";
import { agentFaceUrl } from "#src/server/apps/app-logo.server";
import { humanLabel } from "#src/lib/human-label";
import { ACTIVE_AGENT_WHERE, ROSTER_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { directMessageAgentWhere } from "#src/server/agents/agent-visibility.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { visibleChannelWhere } from "./channel-read-access.server";
import { channelVisibilityOf } from "#src/features/conversations/channel-visibility";
import { channelListMembers } from "./channel-list-preview.server";

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

/** How many of the viewer's latest forwards the "most forwarded" order reads. A forward is one
 * snapshot (a message carrying several originals is several rows), counted once per message. */
const FORWARD_HISTORY_WINDOW = 500;

type ForwardHistory = Map<string, { count: number; last: number }>;

/**
 * How often the viewer forwarded into each conversation, from their latest forwards, newest
 * first. Only their own forwards, in this Workspace. Bounded by `FORWARD_HISTORY_WINDOW`.
 *
 * The count reads the forward rows themselves (task #78): each row was stamped with the
 * Workspace and the person who made it when it was written, and
 * `message_forwards (workspaceId, senderUserId, createdAt DESC)` walks their forwards newest
 * first and stops after the window. Reading the messages instead — where the forwards used to be
 * found by an `EXISTS` per message — scanned the Workspace's messages newest first and matched
 * each row's sender, so a member who never forwarded read every message in the Workspace
 * (92 ms at 360k messages and growing with it) before returning nothing.
 */
export async function forwardHistory(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<ForwardHistory> {
  const forwards = await db.messageForward.findMany({
    where: { workspaceId, senderUserId: userId },
    orderBy: { createdAt: "desc" },
    take: FORWARD_HISTORY_WINDOW,
    select: { messageId: true, message: { select: { conversationId: true, createdAt: true } } },
  });
  const history: ForwardHistory = new Map();
  const counted = new Set<string>();
  for (const { messageId, message } of forwards) {
    // Several originals ride one message; the conversation is counted once per message, as one
    // forwarding act.
    if (counted.has(messageId)) continue;
    counted.add(messageId);
    const seen = history.get(message.conversationId);
    if (seen) seen.count += 1;
    else history.set(message.conversationId, { count: 1, last: message.createdAt.getTime() });
  }
  return history;
}

/** The channels, people and Agents behind the conversations forwarded into: a direct
 * conversation's key names who is on its other side. */
async function forwardedPeers(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  history: ForwardHistory,
) {
  const peers = { channelIds: [] as string[], userIds: [] as string[], agentIds: [] as string[] };
  if (!history.size) return peers;
  const conversations = await db.conversation.findMany({
    where: { workspaceId, id: { in: [...history.keys()] } },
    select: { id: true, directKey: true },
  });
  for (const { id, directKey } of conversations) {
    if (!directKey) {
      peers.channelIds.push(id);
      continue;
    }
    const parts = directKey.split("|");
    const agent = parts.find((part) => part.startsWith("agent:"));
    if (agent) {
      if (parts.includes(`user:${userId}`)) peers.agentIds.push(agent.slice("agent:".length));
      continue;
    }
    const users = parts.map((part) => part.slice("user:".length));
    if (users.includes(userId)) peers.userIds.push(users.find((id) => id !== userId) ?? userId);
  }
  return peers;
}

/**
 * Where the viewer can forward a message, for a picker's search: channels (joined ones first),
 * members and Agents they may message, each with the direct conversation they already have. A
 * person is found by name, never by username. `joined` and `canSend` tell the picker what to ask
 * or disable, from the same rules a forward is checked by: an archived channel takes none, and a
 * channel the viewer has not joined is joined first, at their say-so.
 *
 * The ones the viewer forwards to most come first (Frank, 11-10, task #50), by how many of their
 * forwards went there, then the latest; mixed, whatever their kind. Raft lists by kind and name;
 * this differs on purpose. Only what the search would offer anyway is moved up: the history is
 * matched through the same rules, so a private channel left since, an archived Agent or a member
 * gone from the Workspace stays out. The rest keep their order.
 */
export async function searchForwardTargets(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; q: string; limit: number },
): Promise<ForwardTarget[]> {
  const { workspaceId, userId, limit } = input;
  const q = input.q.trim();
  await requireWorkspaceMember(db, workspaceId, userId);
  const history = await forwardHistory(db, workspaceId, userId);
  const frequent = await forwardedPeers(db, workspaceId, userId, history);
  const named = q ? { contains: q, mode: "insensitive" as const } : undefined;
  const channelSelect = {
    id: true,
    channelName: true,
    visibility: true,
    archivedAt: true,
    members: { where: { userId, ...ACTIVE_MEMBER_WHERE }, select: { id: true }, take: 1 },
  } as const;
  const channelWhere = {
    ...visibleChannelWhere(workspaceId, { userId }),
    kind: null,
    channelName: named ?? { not: null },
  };
  const peopleWhere = { workspaceId, ...(named ? { user: { displayName: named } } : {}) };
  const peopleSelect = {
    user: { select: { id: true, displayName: true, avatarObjectKey: true } },
  } as const;
  const agentWhere = {
    workspaceId,
    ...ACTIVE_AGENT_WHERE,
    AND: [
      ROSTER_AGENT_WHERE,
      directMessageAgentWhere(userId),
      ...(named ? [{ OR: [{ name: named }, { displayName: named }] }] : []),
    ],
  };
  const agentSelect = {
    id: true,
    name: true,
    displayName: true,
    description: true,
    avatarMascot: true,
  } as const;
  const [
    joinedChannels,
    otherChannels,
    people,
    agents,
    frequentChannels,
    frequentPeople,
    frequentAgents,
  ] = await Promise.all([
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
      where: peopleWhere,
      orderBy: { user: { displayName: "asc" } },
      take: limit,
      select: peopleSelect,
    }),
    db.agent.findMany({
      where: agentWhere,
      orderBy: { name: "asc" },
      take: limit,
      select: agentSelect,
    }),
    frequent.channelIds.length
      ? db.conversation.findMany({
          where: { ...channelWhere, id: { in: frequent.channelIds } },
          select: channelSelect,
        })
      : [],
    frequent.userIds.length
      ? db.workspaceMembership.findMany({
          where: { ...peopleWhere, userId: { in: frequent.userIds } },
          select: peopleSelect,
        })
      : [],
    frequent.agentIds.length
      ? db.agent.findMany({
          where: { ...agentWhere, id: { in: frequent.agentIds } },
          select: agentSelect,
        })
      : [],
  ]);
  const directKeys = [
    ...[...people, ...frequentPeople].map(({ user }) => peopleDirectKey(userId, user.id)),
    ...[...agents, ...frequentAgents].map((agent) => agentDirectKey(userId, agent.id)),
  ];
  const directs = directKeys.length
    ? await db.conversation.findMany({
        where: { workspaceId, directKey: { in: [...new Set(directKeys)] } },
        select: { id: true, directKey: true },
      })
    : [];
  const directOf = new Map(directs.map((direct) => [direct.directKey, direct.id]));
  // Each channel's group avatar, as the sidebar draws it (Frank, 11-10: a channel is never a `#`).
  const avatarMembers = await channelListMembers(db, workspaceId, [
    ...new Set([...joinedChannels, ...otherChannels, ...frequentChannels].map(({ id }) => id)),
  ]);
  const toChannel = (channel: (typeof joinedChannels)[number]): ForwardTarget => ({
    kind: "channel",
    conversationId: channel.id,
    name: channel.channelName!,
    visibility: channelVisibilityOf(channel),
    members: avatarMembers.get(channel.id) ?? [],
    joined: channel.members.length > 0,
    canSend: channel.archivedAt === null,
  });
  const toPerson = ({ user }: (typeof people)[number]): ForwardTarget => {
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
  };
  const toBot = (agent: (typeof agents)[number]): ForwardTarget => {
    const conversationId = directOf.get(agentDirectKey(userId, agent.id));
    return {
      kind: "agent",
      agentId: agent.id,
      name: agent.displayName.trim() || agent.name,
      handle: agent.name,
      description: agent.description,
      avatarUrl: agentFaceUrl(agent),
      ...(conversationId ? { conversationId } : {}),
      joined: true,
      canSend: true,
    };
  };
  const forwardedTo = (target: ForwardTarget) =>
    target.conversationId === undefined ? undefined : history.get(target.conversationId);
  const mostForwarded = [
    ...frequentChannels.map(toChannel),
    ...frequentPeople.map(toPerson),
    ...frequentAgents.map(toBot),
  ]
    .flatMap((target) => {
      const seen = forwardedTo(target);
      return seen ? [{ target, ...seen }] : [];
    })
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .map(({ target }) => target);
  const first = new Set(mostForwarded.map(targetIdentity));
  const rest = (targets: ForwardTarget[]) =>
    targets.filter((target) => !first.has(targetIdentity(target)));
  return [
    ...mostForwarded,
    ...interleave(
      [
        rest([...joinedChannels, ...otherChannels].map(toChannel)),
        rest(people.map(toPerson)),
        rest(agents.map(toBot)),
      ],
      limit,
    ),
  ].slice(0, limit);
}

/** One target's identity across the lists: its channel, person or Agent. */
function targetIdentity(target: ForwardTarget) {
  return target.kind === "channel"
    ? `channel:${target.conversationId}`
    : target.kind === "person"
      ? `person:${target.userId}`
      : `agent:${target.agentId}`;
}
