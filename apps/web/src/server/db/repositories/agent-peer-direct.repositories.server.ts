import type { PrismaClient } from "#src/generated/prisma/client";
import { agentPeerDirectKey, agentPeerOf } from "#src/features/conversations/direct-key";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  agentVisibilityViewerForActor,
  canSeeAgent,
} from "#src/server/agents/agent-visibility.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { parsePeerTarget } from "./agent-peer-target.server";
import type { AgentRecoveryRow } from "./agent-recovery-row.server";
import { MESSAGE_ANCHOR } from "./direct-conversation-anchor.server";

/**
 * Agent-to-Agent direct conversations: who an Agent's `@name`, `@name~agent` or `@name~human`
 * target names, the conversation two Agents share (keyed `agent:<a>|agent:<b>`, both as members,
 * no person), and how that conversation is addressed from each seat. The person-and-Agent direct
 * conversation keeps its own paths in `direct-conversation.repositories.server.ts`.
 */

/** Who a direct target names. A person is resolved further by the person-and-Agent paths. */
export type DirectPeer = { kind: "user"; userId: string } | { kind: "agent"; agentId: string };

type Db = Pick<PrismaClient, "agent" | "user" | "workspaceMembership" | "conversation">;

/**
 * The peer a direct target names, from `agentId`'s seat. An Agent counts only while it is live,
 * an ordinary Agent (no platform assistant or app bot), not the sender itself, and either visible
 * to the sender (`canSeeAgent`) or already in a conversation with it: visibility gates starting a
 * conversation, while membership decides who may keep talking in one, so an Agent whose visibility
 * changed can still answer. A person counts for ambiguity only while a Workspace member, so a
 * username elsewhere neither blocks an Agent's name nor shows that it exists.
 *
 * A bare `@name` that is both a member and a usable Agent is `AMBIGUOUS_TARGET`; the suffix picks.
 */
async function resolveDirectPeer(
  db: Db,
  scope: { workspaceId: string; agentId: string },
  parentTarget: string,
): Promise<DirectPeer> {
  const { name, kind } = parsePeerTarget(parentTarget);
  const [agent, user] = await Promise.all([
    kind === "human" ? null : usableAgent(db, scope, name),
    kind === "agent"
      ? null
      : db.user.findUnique({ where: { username: name }, select: { id: true } }),
  ]);
  if (!agent) {
    if (!user) throw new Error("target user not found");
    return { kind: "user", userId: user.id };
  }
  if (user) {
    const member = await db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: scope.workspaceId, userId: user.id } },
      select: { userId: true },
    });
    if (member) throw new AppError("AMBIGUOUS_TARGET");
  }
  return { kind: "agent", agentId: agent.id };
}

async function usableAgent(db: Db, scope: { workspaceId: string; agentId: string }, name: string) {
  return (await usableAgents(db, scope, [name])).get(name);
}

/**
 * The Agents among `names` that the reader may address: live, ordinary (no platform assistant or
 * app bot), not the reader itself, and either visible to it (`canSeeAgent`) or already in a
 * conversation with it. The one rule for resolving a target and for deciding that a name needs a
 * suffix, so a name the reader cannot see neither blocks a bare `@name` nor shows that it exists.
 */
async function usableAgents(
  db: Db,
  scope: { workspaceId: string; agentId: string },
  names: readonly string[],
) {
  const unique = [...new Set(names)];
  const usable = new Map<string, { id: string }>();
  if (!unique.length) return usable;
  const candidates = await db.agent.findMany({
    where: {
      workspaceId: scope.workspaceId,
      name: { in: unique },
      systemKind: null,
      id: { not: scope.agentId },
      ...ACTIVE_AGENT_WHERE,
    },
    select: { id: true, name: true, ownerId: true, visibility: true, systemKind: true },
  });
  if (!candidates.length) return usable;
  const [viewer, talking] = await Promise.all([
    agentVisibilityViewerForActor(db, scope.workspaceId, { agentId: scope.agentId }),
    db.conversation.findMany({
      where: {
        workspaceId: scope.workspaceId,
        directKey: { in: candidates.map((c) => agentPeerDirectKey(scope.agentId, c.id)) },
      },
      select: { directKey: true },
    }),
  ]);
  const talkingKeys = new Set(talking.map((conversation) => conversation.directKey));
  for (const candidate of candidates)
    if (
      talkingKeys.has(agentPeerDirectKey(scope.agentId, candidate.id)) ||
      canSeeAgent(viewer, candidate)
    )
      usable.set(candidate.name, { id: candidate.id });
  return usable;
}

/** The two Agents' conversation, or `null`: a lookup never starts one. */
export function findAgentPeerConversation(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  agentId: string,
  peerAgentId: string,
) {
  return db.conversation.findUnique({
    where: {
      workspaceId_directKey: { workspaceId, directKey: agentPeerDirectKey(agentId, peerAgentId) },
    },
    select: { id: true },
  });
}

/** The two Agents' conversation, started with both as members when it does not exist yet. */
export async function getOrCreateAgentPeerConversation(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  agentId: string,
  peerAgentId: string,
) {
  const existing = await findAgentPeerConversation(db, workspaceId, agentId, peerAgentId);
  if (existing) return existing;
  const directKey = agentPeerDirectKey(agentId, peerAgentId);
  try {
    return await db.conversation.create({
      data: {
        workspace: { connect: { id: workspaceId } },
        directKey,
        members: {
          create: [agentId, peerAgentId].map((id) => ({
            workspace: { connect: { id: workspaceId } },
            agent: { connect: { id } },
          })),
        },
      },
      select: { id: true },
    });
  } catch (error) {
    // A concurrent first message won the insert; reuse its conversation.
    if (isUniqueViolation(error))
      return db.conversation.findUniqueOrThrow({
        where: { workspaceId_directKey: { workspaceId, directKey } },
        select: { id: true },
      });
    throw error;
  }
}

/** The other side of a direct conversation, from a reader's seat. */
export type DirectSeat = { name: string; kind: "human" | "agent" };

/**
 * `@name` for each seat, with the suffix that keeps it executable as shown: `~human` on a person
 * whose name a live ordinary Agent also holds, `~agent` on an Agent whose name a Workspace member
 * also holds (a bare name in those cases is `AMBIGUOUS_TARGET`); an Agent the reader cannot address does not count (`usableAgents`). One read per kind for the whole
 * batch, never one per row.
 */
export async function directRefs(
  db: Db,
  workspaceId: string,
  readerAgentId: string,
  seats: readonly DirectSeat[],
) {
  const namesOf = (kind: DirectSeat["kind"]) =>
    seats.flatMap((seat) => (seat.kind === kind ? [seat.name] : []));
  const [agents, memberNames] = await Promise.all([
    usableAgents(db, { workspaceId, agentId: readerAgentId }, namesOf("human")),
    memberUsernamesAmong(db, workspaceId, namesOf("agent")),
  ]);
  return ({ name, kind }: DirectSeat) =>
    `@${name}${kind === "human" ? (agents.has(name) ? "~human" : "") : memberNames.has(name) ? "~agent" : ""}`;
}

/** What `conversationTarget` reads of a conversation to name it from a reader's seat. */
export type TargetConversation = {
  channelName: string | null;
  directKey?: string | null;
  members: { user?: { username: string } | null; agent?: { id: string; name: string } | null }[];
};

/** The target of a direct conversation from the reader's seat (`directTargets`); `undefined` for a
 * conversation with no person and no Agent peer, which only an App's events are. */
export type DirectTargetOf = (conversation: TargetConversation) => string | undefined;

/** `directRefs` for each direct conversation in the batch: its person, or its Agent peer. */
export async function directTargets(
  db: Db,
  workspaceId: string,
  readerAgentId: string,
  conversations: readonly TargetConversation[],
): Promise<DirectTargetOf> {
  const seatOf = (conversation: TargetConversation): DirectSeat | undefined => {
    if (conversation.channelName) return undefined;
    const username = conversation.members.find((member) => member.user)?.user?.username;
    if (username) return { name: username, kind: "human" };
    const peerId = agentPeerOf(conversation.directKey ?? null, readerAgentId);
    const name = conversation.members.find((member) => member.agent?.id === peerId)?.agent?.name;
    return name === undefined ? undefined : { name, kind: "agent" };
  };
  const refOf = await directRefs(
    db,
    workspaceId,
    readerAgentId,
    conversations.flatMap((conversation) => seatOf(conversation) ?? []),
  );
  return (conversation) => {
    const seat = seatOf(conversation);
    return seat && refOf(seat);
  };
}

/**
 * The conversation a direct target names and who it is with, opened through `open`: the
 * person-and-Agent paths for a person, and `open.agent` for an Agent peer (started with
 * `getOrCreateAgentPeerConversation`, or only looked up for a read that must not start one).
 */
export async function openDirectPeerConversation<Conversation>(
  db: Db,
  scope: { workspaceId: string; agentId: string },
  parentTarget: string,
  open: {
    user: (userId: string) => Promise<Conversation>;
    agent: (peerAgentId: string) => Promise<Conversation>;
  },
) {
  const peer = await resolveDirectPeer(db, scope, parentTarget);
  const conversation = await (peer.kind === "user"
    ? open.user(peer.userId)
    : open.agent(peer.agentId));
  return { conversation, peer };
}

/** The `@…` part of a direct target, once the whole target is known to be at most `@…:<root>`. */
export function dmParentTarget(target: string) {
  const [parentTarget, root, extra] = target.split(":");
  if (extra !== undefined || (root !== undefined && !MESSAGE_ANCHOR.test(root)))
    throw new Error("invalid message target");
  return parentTarget!;
}

/** The target of a conversation between two Agents as `readerAgentId` sees it, from its members as
 * a send loaded them. */
export async function peerSeatTarget(
  db: Db,
  conversation: { workspaceId: string; directKey: string | null },
  members: { agentId: string | null; agent?: { name: string } | null }[],
  readerAgentId: string,
) {
  const peerId = agentPeerOf(conversation.directKey, readerAgentId);
  const name = members.find((member) => member.agentId === peerId)?.agent?.name;
  if (name === undefined) throw new Error("direct conversation has no addressable peer");
  const refOf = await directRefs(db, conversation.workspaceId, readerAgentId, [
    { name, kind: "agent" },
  ]);
  return refOf({ name, kind: "agent" });
}

/** The other Agent of a conversation between two Agents, from `agentId`'s seat, while it is live;
 * `undefined` once it is deleted. */
export async function liveAgentPeer(
  db: Pick<PrismaClient, "agent">,
  conversation: { workspaceId: string; directKey: string | null },
  agentId: string,
) {
  const peerId = agentPeerOf(conversation.directKey, agentId);
  if (!peerId) return undefined;
  return db.agent.findFirst({
    where: { id: peerId, workspaceId: conversation.workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { id: true },
  });
}

/** Which of `names` are the username of a member of the Workspace. */
async function memberUsernamesAmong(
  db: Pick<PrismaClient, "user">,
  workspaceId: string,
  names: readonly string[],
) {
  const unique = [...new Set(names)];
  if (!unique.length) return new Set<string>();
  const users = await db.user.findMany({
    where: { username: { in: unique }, memberships: { some: { workspaceId } } },
    select: { username: true },
  });
  return new Set(users.map((user) => user.username));
}

/** A person's `@username` as the Agent should address it back: `~human` if an Agent holds it too. */
export async function humanRef(
  db: Db,
  workspaceId: string,
  readerAgentId: string,
  username: string,
) {
  const seat = { name: username, kind: "human" } as const;
  return (await directRefs(db, workspaceId, readerAgentId, [seat]))(seat);
}

/** `directRefs` for the direct rows of an Agent recovery batch (`otherUsername`, `agentPeer`). */
export async function recoveryRefs(
  db: Db,
  workspaceId: string,
  readerAgentId: string,
  rows: readonly Pick<AgentRecoveryRow, "channelName" | "otherUsername" | "agentPeer">[],
) {
  const seatOf = (row: (typeof rows)[number]): DirectSeat => ({
    name: row.otherUsername!,
    kind: row.agentPeer ? "agent" : "human",
  });
  const refOf = await directRefs(
    db,
    workspaceId,
    readerAgentId,
    rows.flatMap((row) => (row.channelName || !row.otherUsername ? [] : [seatOf(row)])),
  );
  return (row: (typeof rows)[number]) => refOf(seatOf(row));
}
