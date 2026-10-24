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
  const peer = await db.agent.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      name,
      systemKind: null,
      id: { not: scope.agentId },
      ...ACTIVE_AGENT_WHERE,
    },
    select: { id: true, ownerId: true, visibility: true, systemKind: true },
  });
  if (!peer) return null;
  if (await findAgentPeerConversation(db, scope.workspaceId, scope.agentId, peer.id)) return peer;
  const viewer = await agentVisibilityViewerForActor(db, scope.workspaceId, {
    agentId: scope.agentId,
  });
  return canSeeAgent(viewer, peer) ? peer : null;
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

/** What `conversationTarget` reads of a conversation to name it from a reader's seat. */
export type TargetConversation = {
  channelName: string | null;
  directKey?: string | null;
  members: { user?: { username: string } | null; agent?: { id: string; name: string } | null }[];
};

/**
 * The target of each conversation from `readerAgentId`'s seat: `@name~agent` for an Agent peer
 * whose name a Workspace member also holds (the suffix is how the Agent tells them apart), and
 * `@name` otherwise. One read of the colliding usernames for the whole batch, never one per row.
 */
export async function agentPeerNames(
  db: Pick<PrismaClient, "user">,
  workspaceId: string,
  readerAgentId: string,
  conversations: readonly TargetConversation[],
): Promise<(conversation: TargetConversation) => string | undefined> {
  const peerName = (conversation: TargetConversation) => {
    const peerId = agentPeerOf(conversation.directKey ?? null, readerAgentId);
    return peerId
      ? conversation.members.find((m) => m.agent?.id === peerId)?.agent?.name
      : undefined;
  };
  const taken = await memberUsernamesAmong(
    db,
    workspaceId,
    conversations.flatMap((conversation) => peerName(conversation) ?? []),
  );
  return (conversation) => {
    const name = peerName(conversation);
    return name === undefined ? undefined : `@${name}${agentSuffix(taken, name)}`;
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
  db: Pick<PrismaClient, "user">,
  conversation: { workspaceId: string; directKey: string | null },
  members: { agentId: string | null; agent?: { name: string } | null }[],
  readerAgentId: string,
) {
  const peerId = agentPeerOf(conversation.directKey, readerAgentId);
  const name = members.find((member) => member.agentId === peerId)?.agent?.name;
  if (name === undefined) throw new Error("direct conversation has no addressable peer");
  const taken = await memberUsernamesAmong(db, conversation.workspaceId, [name]);
  return `@${name}${agentSuffix(taken, name)}`;
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

/** `~agent` after an Agent peer's name that a Workspace member also holds, else empty: the one
 * rule for naming an Agent peer, from the batch's rows. One read of the colliding usernames. */
export async function agentPeerSuffix(
  db: Pick<PrismaClient, "user">,
  workspaceId: string,
  rows: readonly { agentPeer: boolean; otherUsername: string | null }[],
) {
  const taken = await memberUsernamesAmong(
    db,
    workspaceId,
    rows.flatMap((row) => (row.agentPeer && row.otherUsername ? [row.otherUsername] : [])),
  );
  return (row: { agentPeer: boolean; otherUsername: string | null }) =>
    row.agentPeer && row.otherUsername ? agentSuffix(taken, row.otherUsername) : "";
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

/** `~agent` after an Agent peer's name when a Workspace member holds it too, else empty: the one
 * rule for naming an Agent peer. */
const agentSuffix = (taken: ReadonlySet<string>, name: string) => (taken.has(name) ? "~agent" : "");
