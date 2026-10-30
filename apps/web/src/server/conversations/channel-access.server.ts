import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { channelThreadRootWhere } from "#src/server/db/message-anchor.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import { AgentMessageValidationError } from "./agent-message-validation-error.server";
import type { ChannelActor } from "./channel-actor.server";
import {
  channelByIdWhere,
  requireReadableChannel,
  visibleChannelWhere,
} from "./channel-read-access.server";
import type { ConversationRealtime } from "./conversation-realtime.server";

/** What `PublicChannels` hands each of its channel modules: the database, and the publishers a
 * write announces itself through after it commits. */
export type PublicChannelPorts = {
  db: PrismaClient;
  publisher?: CentrifugoServerApi;
  realtime?: ConversationRealtime;
  inboxPurge: Pick<AgentInboxPurgePublisher, "purge">;
};

export async function getAgentChannel(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  target: string,
) {
  if (!/^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target)) throw new AppError("INVALID_INPUT");
  const channel = await db.conversation.findFirst({
    where: {
      workspaceId,
      channelName: target.slice(1),
      ...VISIBLE_CONVERSATION_WHERE,
      members: { some: { agentId, agent: { workspaceId }, ...ACTIVE_MEMBER_WHERE } },
    },
  });
  if (!channel) throw new AppError("ACCESS_DENIED");
  return channel;
}

/**
 * `getAgentChannel` for the send path: the Agent's channel, or one it could join anyway on the
 * way to posting — visible (as above), public, unarchived, and the Agent public (a private Agent can
 * never be a channel member). `needsJoin` marks the latter; the membership itself is written by
 * the send's transaction, so a failed send leaves none. An app's bot is refused: it posts only
 * where it was added. Anything else is the same `ACCESS_DENIED` a non-member's send has always
 * had.
 */
export async function getAgentSendChannel(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
  target: string,
) {
  if (!/^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target)) throw new AppError("INVALID_INPUT");
  // Only a channel it may read (`visibleChannelWhere`): a private one it is not in is never joined
  // on the way.
  const channel = await db.conversation.findFirst({
    where: { ...visibleChannelWhere(workspaceId, { agentId }), channelName: target.slice(1) },
    select: {
      id: true,
      channelName: true,
      archivedAt: true,
      members: { where: { agentId }, select: { id: true, leftAt: true } },
    },
  });
  if (!channel) throw new AppError("ACCESS_DENIED");
  const member = channel.members[0];
  if (member && member.leftAt === null)
    return { id: channel.id, channelName: channel.channelName, needsJoin: false };
  if (channel.archivedAt) throw new AppError("ACCESS_DENIED");
  const [agent, bot] = await Promise.all([
    db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { visibility: true },
    }),
    // An app's bot is an installed identity, not a member of the Workspace's conversations: it
    // posts only where it was added, never by joining on the way.
    db.appInstallationBot.findFirst({ where: { agentId }, select: { id: true } }),
  ]);
  if (agent?.visibility !== AGENT_VISIBILITY.PUBLIC || bot) throw new AppError("ACCESS_DENIED");
  return { id: channel.id, channelName: channel.channelName, needsJoin: true };
}

/**
 * Resolves a thread anchor (an eight-hex prefix or a full UUID) to its top-level root Message in
 * `conversationId`. Shared by the channel thread operations and `ActionCards.prepare`
 * (`action-cards.server.ts`) so a channel thread target resolves identically everywhere.
 */
export async function resolveChannelThreadRoot(
  db: Pick<PrismaClient, "message">,
  conversationId: string,
  anchor: string,
) {
  const rows = await db.message.findMany({
    where: channelThreadRootWhere(conversationId, anchor),
    take: 2,
    select: { id: true },
  });
  if (rows.length > 1)
    throw new AgentMessageValidationError("ambiguous message prefix; use the full UUID");
  if (!rows[0])
    throw new AgentMessageValidationError("message anchor not found in this conversation");
  return rows[0];
}

/** The `ChannelActor` equivalent of `requireWorkspaceMember`: a human must be a Workspace member,
 * an Agent must belong to the Workspace. */
export async function authorizeChannelActor(
  db: PrismaClient,
  workspaceId: string,
  actor: ChannelActor,
) {
  if ("userId" in actor) return requireWorkspaceMember(db, workspaceId, actor.userId);
  const agent = await db.agent.findFirst({
    where: { id: actor.agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { id: true },
  });
  if (!agent) throw new AppError("ACCESS_DENIED");
}

/** The channel `reader` may read, or `NOT_FOUND`: one they cannot read is a missing one. */
export async function findChannelById(
  db: PrismaClient,
  workspaceId: string,
  reader: ChannelActor,
  channelId: string,
) {
  const channel = await db.conversation.findFirst({
    where: channelByIdWhere(workspaceId, channelId),
    select: { id: true, channelName: true, description: true, archivedAt: true, visibility: true },
  });
  return requireReadableChannel(db, workspaceId, reader, channel);
}

/** A Workspace member's view of one channel, with the viewer's Workspace role. The membership and
 * the channel are read at once; a non-member is still refused before a missing channel is
 * reported, and a private channel the viewer is not in is a missing one. */
export async function viewerChannel(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  channelId: string,
) {
  const [membership, channel] = await Promise.all([
    db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    }),
    db.conversation.findFirst({
      where: channelByIdWhere(workspaceId, channelId),
      include: {
        project: {
          select: { id: true, name: true, slug: true, githubFullName: true, githubHtmlUrl: true },
        },
        coordinatorAgent: { select: { id: true, name: true, displayName: true } },
      },
    }),
  ]);
  if (!membership) throw new AppError("ACCESS_DENIED");
  return {
    channel: await requireReadableChannel(db, workspaceId, { userId }, channel),
    serverRole: membership.role,
  };
}

/** `viewerChannel` without the role: the channel a Workspace member asked for. */
export async function memberChannel(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  channelId: string,
) {
  return (await viewerChannel(db, workspaceId, userId, channelId)).channel;
}

/** A person's active member row in a channel (`ACTIVE_MEMBER_WHERE`): a soft-left row is not
 * one. */
export function activeUserMember(
  db: Pick<Prisma.TransactionClient, "conversationMember">,
  channelId: string,
  userId: string,
) {
  return db.conversationMember.findFirst({
    where: { conversationId: channelId, userId, ...ACTIVE_MEMBER_WHERE },
    select: { id: true },
  });
}

/** The channel's newest sequence, top-level or thread reply; 0 for an empty channel. A (re-)joining
 * or added member's read cursor starts here. */
export async function channelEndSequence(db: Prisma.TransactionClient, channelId: string) {
  const latest = await db.message.findFirst({
    where: { conversationId: channelId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return latest?.sequence ?? 0;
}
