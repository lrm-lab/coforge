import type { PrismaClient } from "#src/generated/prisma/client";
import {
  canonicalTaskReference,
  readTaskReferenceToken,
  TASK_REFERENCE_TOKEN_PATTERN,
  type TaskReference,
} from "@lrm/coforge-sdk/internal";

/** What a reference to a task the reader may not see reads as: no name, number or status. */
export const HIDDEN_TASK_REFERENCE = "a task you cannot view";

/** The conversations a body references as tasks, by kind, deduped. */
export function taskReferenceConversations(body: string): {
  channel: string[];
  dm: string[];
} {
  const channel = new Set<string>();
  const dm = new Set<string>();
  for (const match of body.matchAll(TASK_REFERENCE_TOKEN_PATTERN)) {
    const reference = readTaskReferenceToken(match as unknown as RegExpExecArray);
    if (reference?.kind === "channel") channel.add(reference.conversationId);
    else if (reference?.kind === "dm") dm.add(reference.conversationId);
  }
  return { channel: [...channel], dm: [...dm] };
}

type TaskReferenceDb = Pick<PrismaClient, "conversationMember" | "conversation" | "user" | "agent">;
type TaskReferenceFormatter = (reference: TaskReference) => string | undefined;

export async function taskReferenceViews(
  db: TaskReferenceDb,
  workspaceId: string,
  readerAgentIds: readonly string[],
  currentConversationId: string,
  body: string,
): Promise<Map<string, TaskReferenceFormatter>> {
  const uniqueAgentIds = [...new Set(readerAgentIds)];
  if (uniqueAgentIds.length === 0) return new Map();
  const referenced = taskReferenceConversations(body);
  if (referenced.channel.length === 0 && referenced.dm.length === 0) return new Map();
  const dmConversations = referenced.dm.filter(
    (conversationId) => conversationId !== currentConversationId,
  );
  const [channels, dmMemberships] = await Promise.all([
    referenced.channel.length > 0
      ? db.conversation.findMany({
          where: {
            id: { in: referenced.channel },
            workspaceId,
            OR: [
              { visibility: "public" },
              { members: { some: { agentId: { in: uniqueAgentIds }, leftAt: null } } },
            ],
          },
          select: {
            id: true,
            visibility: true,
            members: {
              where: {
                agentId: { in: uniqueAgentIds },
                leftAt: null,
                conversation: { visibility: { not: "public" } },
              },
              select: { agentId: true },
            },
          },
        })
      : [],
    dmConversations.length > 0
      ? db.conversationMember.findMany({
          where: {
            conversationId: { in: dmConversations },
            agentId: { in: uniqueAgentIds },
            leftAt: null,
          },
          select: { conversationId: true, agentId: true },
        })
      : [],
  ]);

  const addToSet = (map: Map<string, Set<string>>, key: string, value: string) => {
    let set = map.get(key);
    if (!set) {
      set = new Set<string>();
      map.set(key, set);
    }
    set.add(value);
  };

  const publicChannels = new Set<string>();
  const privateChannelsByAgent = new Map<string, Set<string>>();
  for (const channel of channels) {
    if (channel.visibility === "public") {
      publicChannels.add(channel.id);
      continue;
    }
    for (const member of channel.members) {
      if (member.agentId) addToSet(privateChannelsByAgent, member.agentId, channel.id);
    }
  }

  const readableDmsByAgent = new Map<string, Set<string>>();
  const allReadableDms = new Set<string>();
  for (const membership of dmMemberships) {
    if (!membership.agentId) continue;
    allReadableDms.add(membership.conversationId);
    addToSet(readableDmsByAgent, membership.agentId, membership.conversationId);
  }

  const peerByAgentAndDm = new Map<
    string,
    Map<string, { handle: string; kind: "user" | "agent" }>
  >();
  let ambiguous = new Set<string>();

  if (allReadableDms.size > 0) {
    const dmMembers = await db.conversationMember.findMany({
      where: {
        conversationId: { in: [...allReadableDms] },
        leftAt: null,
      },
      select: { conversationId: true, userId: true, agentId: true },
    });
    const userIds = [
      ...new Set(dmMembers.flatMap((member) => (member.userId ? [member.userId] : []))),
    ];
    const agentIds = [
      ...new Set(dmMembers.flatMap((member) => (member.agentId ? [member.agentId] : []))),
    ];
    const [users, agents] = await Promise.all([
      userIds.length > 0
        ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } })
        : [],
      agentIds.length > 0
        ? db.agent.findMany({
            where: { id: { in: agentIds }, workspaceId },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const usernameOf = new Map(users.map((user) => [user.id, user.username]));
    const agentNameOf = new Map(agents.map((agent) => [agent.id, agent.name]));
    const membersByDm = new Map<string, typeof dmMembers>();
    for (const member of dmMembers) {
      let group = membersByDm.get(member.conversationId);
      if (!group) {
        group = [];
        membersByDm.set(member.conversationId, group);
      }
      group.push(member);
    }
    const handleSet = new Set<string>();
    for (const [agentId, dms] of readableDmsByAgent) {
      const peerOf = new Map<string, { handle: string; kind: "user" | "agent" }>();
      for (const dmId of dms) {
        const members = membersByDm.get(dmId) ?? [];
        for (const other of members) {
          if (other.agentId === agentId) continue;
          const handle = other.userId
            ? usernameOf.get(other.userId)
            : other.agentId
              ? agentNameOf.get(other.agentId)
              : undefined;
          if (handle) {
            peerOf.set(dmId, { handle, kind: other.userId ? "user" : "agent" });
            handleSet.add(handle);
          }
        }
      }
      peerByAgentAndDm.set(agentId, peerOf);
    }
    const handles = [...handleSet];
    if (handles.length > 0) {
      const [userHandles, agentHandles] = await Promise.all([
        db.user.findMany({ where: { username: { in: handles } }, select: { username: true } }),
        db.agent.findMany({
          where: { workspaceId, name: { in: handles } },
          select: { name: true },
        }),
      ]);
      const agentNames = new Set(agentHandles.map((agent) => agent.name));
      ambiguous = new Set(
        userHandles.map((user) => user.username).filter((name) => agentNames.has(name)),
      );
    }
  }

  const views = new Map<string, TaskReferenceFormatter>();
  for (const agentId of uniqueAgentIds) {
    const privateChannels = privateChannelsByAgent.get(agentId);
    const peerOf = peerByAgentAndDm.get(agentId);
    views.set(agentId, (reference) => {
      if (reference.kind === "channel") {
        return publicChannels.has(reference.conversationId) ||
          privateChannels?.has(reference.conversationId)
          ? canonicalTaskReference(reference)
          : HIDDEN_TASK_REFERENCE;
      }
      if (reference.kind !== "dm") return canonicalTaskReference(reference);
      if (reference.conversationId === currentConversationId) return `#${reference.number}`;
      const peer = peerOf?.get(reference.conversationId);
      if (!peer) return canonicalTaskReference(reference);
      const handle = ambiguous.has(peer.handle)
        ? `${peer.handle}~${peer.kind === "agent" ? "agent" : "human"}`
        : peer.handle;
      return `dm:@${handle}:#${reference.number}`;
    });
  }
  return views;
}

export async function taskReferenceView(
  db: TaskReferenceDb,
  workspaceId: string,
  readerAgentId: string,
  currentConversationId: string,
  body: string,
): Promise<TaskReferenceFormatter | undefined> {
  const views = await taskReferenceViews(
    db,
    workspaceId,
    [readerAgentId],
    currentConversationId,
    body,
  );
  return views.get(readerAgentId);
}
