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

/**
 * How a body's task references read for one Agent: a DM's task names the DM's other party from
 * the reader's seat (the peer sees the sender), an own DM's task reads as the local `#N`, and a
 * DM the reader is not in stays canonical. Undefined when the body has no DM reference, so callers
 * skip the read.
 */
export async function taskReferenceView(
  db: Pick<PrismaClient, "conversationMember" | "conversation" | "user" | "agent">,
  workspaceId: string,
  readerAgentId: string,
  currentConversationId: string,
  body: string,
): Promise<((reference: TaskReference) => string | undefined) | undefined> {
  const referenced = taskReferenceConversations(body);
  const all = [...referenced.channel, ...referenced.dm];
  if (all.length === 0) return undefined;
  const channels = referenced.channel.length
    ? await db.conversation.findMany({
        where: {
          id: { in: referenced.channel },
          workspaceId,
          OR: [
            { visibility: "public" },
            { members: { some: { agentId: readerAgentId, leftAt: null } } },
          ],
        },
        select: { id: true },
      })
    : [];
  const readableChannels = new Set(channels.map((channel) => channel.id));
  const conversations = referenced.dm.filter(
    (conversationId) => conversationId !== currentConversationId,
  );
  const mine = await db.conversationMember.findMany({
    where: { conversationId: { in: conversations }, agentId: readerAgentId, leftAt: null },
    select: { conversationId: true },
  });
  const readable = new Set(mine.map((member) => member.conversationId));
  const others = await db.conversationMember.findMany({
    where: {
      conversationId: { in: [...readable] },
      leftAt: null,
      // A person's row has a null agentId; `NOT { agentId }` would drop it with SQL's NULL.
      OR: [{ agentId: null }, { agentId: { not: readerAgentId } }],
    },
    select: { conversationId: true, userId: true, agentId: true },
  });
  const userIds = others.flatMap((member) => (member.userId ? [member.userId] : []));
  const agentIds = others.flatMap((member) => (member.agentId ? [member.agentId] : []));
  const [users, agents] = await Promise.all([
    userIds.length
      ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } })
      : [],
    agentIds.length
      ? db.agent.findMany({
          where: { id: { in: agentIds }, workspaceId },
          select: { id: true, name: true },
        })
      : [],
  ]);
  const usernameOf = new Map(users.map((user) => [user.id, user.username]));
  const agentNameOf = new Map(agents.map((agent) => [agent.id, agent.name]));
  const peerOf = new Map<string, { handle: string; kind: "user" | "agent" }>();
  for (const other of others) {
    const handle = other.userId ? usernameOf.get(other.userId) : agentNameOf.get(other.agentId!);
    if (handle) peerOf.set(other.conversationId, { handle, kind: other.userId ? "user" : "agent" });
  }
  // A handle that names both a person and an Agent needs Raft's kind suffix to be exact.
  const handles = [...new Set([...peerOf.values()].map((peer) => peer.handle))];
  const [userHandles, agentHandles] = handles.length
    ? await Promise.all([
        db.user.findMany({ where: { username: { in: handles } }, select: { username: true } }),
        db.agent.findMany({
          where: { workspaceId, name: { in: handles } },
          select: { name: true },
        }),
      ])
    : [[], []];
  const agentNames = new Set(agentHandles.map((agent) => agent.name));
  const ambiguous = new Set(
    userHandles.map((user) => user.username).filter((name) => agentNames.has(name)),
  );
  return (reference) => {
    if (reference.kind === "channel")
      return readableChannels.has(reference.conversationId)
        ? canonicalTaskReference(reference)
        : HIDDEN_TASK_REFERENCE;
    if (reference.kind !== "dm") return canonicalTaskReference(reference);
    // A DM's own task reads as this conversation's task.
    if (reference.conversationId === currentConversationId) return `#${reference.number}`;
    const peer = peerOf.get(reference.conversationId);
    if (!peer) return canonicalTaskReference(reference);
    const handle = ambiguous.has(peer.handle)
      ? `${peer.handle}~${peer.kind === "agent" ? "agent" : "human"}`
      : peer.handle;
    return `dm:@${handle}:#${reference.number}`;
  };
}
