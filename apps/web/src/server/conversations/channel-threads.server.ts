import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  agentVisibilityViewerForUser,
  canSeeAgent,
  visibleAgentWhere,
} from "#src/server/agents/agent-visibility.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { AgentMessageValidationError } from "./agent-message-validation-error.server";
import {
  activeUserMember,
  getAgentChannel,
  memberChannel,
  resolveChannelThreadRoot,
  type PublicChannelPorts,
} from "./channel-access.server";
import { lockConversation } from "./conversation-lock.server";

/**
 * A channel Thread's followers and a person's read position in it. A thread uses its root
 * Message identity: following one is a `ThreadFollow` row of a member, never a membership.
 */

/**
 * Enrolls the followers a channel thread reply makes, whether a person or an Agent sent it:
 * everyone who takes part (the replier and every member the reply mentions or binds) and, the
 * first time the thread gets a reply, the author of the message replied to. Without that last
 * one, a reply under someone's own message never enrolls them, and since a thread reply is not a
 * parent-channel post, nothing would ever notify them of the discussion started under it. Only
 * while the thread is brand new: an explicit unfollow is a decision, and a later reply must not
 * silently enroll the root author back. Runs before `channelAgentRecipients`, which reads these
 * follows.
 */
export async function enrollThreadReplyFollowers(
  tx: Prisma.TransactionClient,
  reply: {
    workspaceId: string;
    conversationId: string;
    root: { id: string; senderMemberId: string | null };
    participantMemberIds: readonly string[];
  },
): Promise<void> {
  const { workspaceId, conversationId, root } = reply;
  const followerIds = new Set(reply.participantMemberIds);
  const existingFollower = await tx.threadFollow.findFirst({
    where: { rootMessageId: root.id },
    select: { memberId: true },
  });
  if (root.senderMemberId && !existingFollower) followerIds.add(root.senderMemberId);
  await tx.threadFollow.createMany({
    data: [...followerIds].map((memberId) => ({
      memberId,
      rootMessageId: root.id,
      conversationId,
      workspaceId,
    })),
    skipDuplicates: true,
  });
}

async function setThreadFollowed(
  db: PrismaClient,
  memberId: string,
  workspaceId: string,
  conversationId: string,
  rootMessageId: string,
  followed: boolean,
) {
  await db.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    if (followed) {
      await tx.threadFollow.upsert({
        where: { memberId_rootMessageId: { memberId, rootMessageId } },
        create: { memberId, workspaceId, conversationId, rootMessageId },
        update: {},
      });
    } else {
      await tx.threadFollow.deleteMany({ where: { memberId, rootMessageId } });
    }
  });
}

export async function setAgentThreadFollowed(
  { db }: PublicChannelPorts,
  workspaceId: string,
  agentId: string,
  target: string,
  followed: boolean,
) {
  const [parentTarget, anchor] = target.split(":");
  if (!parentTarget || !anchor) throw new AppError("INVALID_INPUT");
  const channel = await getAgentChannel(db, workspaceId, agentId, parentTarget);
  const member = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_agentId: { conversationId: channel.id, agentId } },
    select: { id: true },
  });
  const root = await resolveChannelThreadRoot(db, channel.id, anchor);
  await setThreadFollowed(db, member.id, workspaceId, channel.id, root.id, followed);
  return { followed };
}

export async function setUserThreadFollowed(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  rootMessageId: string,
  followed: boolean,
) {
  await memberChannel(db, workspaceId, userId, channelId);
  // A soft-left member (`leftAt` set) may no longer follow threads, matching `send`'s own
  // ACTIVE_MEMBER_WHERE check: leaving stops all delivery, not just ordinary channel posts.
  const member = await activeUserMember(db, channelId, userId);
  if (!member) throw new AppError("ACCESS_DENIED");
  const root = await resolveChannelThreadRoot(db, channelId, rootMessageId);
  await setThreadFollowed(db, member.id, workspaceId, channelId, root.id, followed);
  return { followed };
}

/**
 * Agents currently following this channel Thread that the viewer may see.
 * Workspace members can read the list with the parent channel; only an active channel
 * member may later unfollow one of them.
 */
export async function threadFollowingAgents(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  rootMessageId: string,
) {
  await memberChannel(db, workspaceId, userId, channelId);
  const root = await resolveChannelThreadRoot(db, channelId, rootMessageId);
  const viewer = await agentVisibilityViewerForUser(db, workspaceId, userId);
  const [actor, follows] = await Promise.all([
    activeUserMember(db, channelId, userId),
    db.threadFollow.findMany({
      where: {
        rootMessageId: root.id,
        conversationId: channelId,
        member: {
          agentId: { not: null },
          ...ACTIVE_MEMBER_WHERE,
          agent: {
            workspaceId,
            ...ACTIVE_AGENT_WHERE,
            ...visibleAgentWhere(viewer),
          },
        },
      },
      select: {
        member: {
          select: {
            agent: {
              select: { id: true, name: true, displayName: true, avatarMascot: true },
            },
          },
        },
      },
    }),
  ]);
  const agents = follows
    .flatMap((follow) => {
      const agent = follow.member.agent;
      if (!agent) return [];
      return [
        {
          id: agent.id,
          name: agent.name,
          displayName: agent.displayName.trim() || agent.name,
          avatarUrl: agentAvatarUrl(agent.id, agent.avatarMascot),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) || left.name.localeCompare(right.name),
    );
  return { canUnfollow: Boolean(actor), agents };
}

/**
 * A human channel member removes an Agent from this Thread's follow set. The Agent stays a
 * channel member; only subsequent ordinary thread notices stop. The viewer must be allowed
 * to see that Agent — a private Agent they cannot see is `NOT_FOUND`.
 */
export async function unfollowAgentFromThread(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  rootMessageId: string,
  agentId: string,
) {
  await memberChannel(db, workspaceId, userId, channelId);
  const actor = await activeUserMember(db, channelId, userId);
  if (!actor) throw new AppError("ACCESS_DENIED");
  const root = await resolveChannelThreadRoot(db, channelId, rootMessageId);
  const agentMember = await db.conversationMember.findFirst({
    where: {
      conversationId: channelId,
      agentId,
      ...ACTIVE_MEMBER_WHERE,
      agent: { workspaceId, ...ACTIVE_AGENT_WHERE },
    },
    select: {
      id: true,
      agent: { select: { visibility: true, systemKind: true, ownerId: true } },
    },
  });
  const viewer = await agentVisibilityViewerForUser(db, workspaceId, userId);
  // Same answer for a missing Agent and a private Agent the viewer cannot see, so the
  // unfollow path cannot be used to probe private-Agent visibility.
  if (!agentMember?.agent || !canSeeAgent(viewer, agentMember.agent))
    throw new AppError("NOT_FOUND");
  await setThreadFollowed(db, agentMember.id, workspaceId, channelId, root.id, false);
  return { followed: false };
}

export async function markThreadReadForUser(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  rootMessageId: string,
  throughSequence: number,
) {
  await memberChannel(db, workspaceId, userId, channelId);
  const root = await db.message.findFirst({
    where: { id: rootMessageId, conversationId: channelId, threadRootId: null },
    select: { id: true },
  });
  if (!root) throw new AgentMessageValidationError("message anchor not found in this conversation");
  const [member, latest] = await Promise.all([
    db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: channelId, userId } },
      select: { id: true },
    }),
    db.message.findFirst({
      where: {
        conversationId: channelId,
        threadRootId: root.id,
        sequence: { lte: throughSequence },
      },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    }),
  ]);
  if (!member || !latest) return;
  await db.$executeRaw`INSERT INTO "thread_reads"
    ("memberId", "conversationId", "workspaceId", "rootMessageId", "readThroughSequence")
    VALUES (${member.id}::uuid, ${channelId}::uuid, ${workspaceId}::uuid, ${root.id}::uuid, ${latest.sequence})
    ON CONFLICT ("memberId", "rootMessageId") DO UPDATE SET "readThroughSequence" =
      GREATEST("thread_reads"."readThroughSequence", EXCLUDED."readThroughSequence")`;
}
