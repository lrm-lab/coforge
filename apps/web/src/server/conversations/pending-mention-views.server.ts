import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { humanLabel } from "#src/lib/human-label";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { canReadChannel } from "./channel-read-access.server";
import { canJoinChannel } from "./mention-target-availability.server";
import { leftoverMentionHandles } from "./unresolved-mentions.server";

/* The pending mentions of a sent message as its sender sees them, with what each still allows;
 * acting on them is `pending-mention-actions.server.ts`. */

/** The channel a mention was sent in, as far as deciding what it still allows needs it. */
type MentionChannel = { archivedAt: Date | null; channelName: string | null; visibility: string };

/** Whether Notify may let a target outside the channel read the message: only a public channel's
 * message reaches a non-member. The view offers it and `notifyMentionTargets` refuses it alike. */
export function notifyReachesOutside(channel: { visibility: string }) {
  return canReadChannel(channel, false);
}

/** What the sender can still do about one pending mention. */
export type MentionActionKind = "notify" | "add";

/** One mention of a sent message that did not reach its target, as its sender sees it. */
export type PendingMentionActionView = {
  resolutionId: string;
  messageId: string;
  targetType: "user" | "agent";
  targetId: string;
  targetHandle: string;
  targetLabel: string;
  targetAvatarUrl: string | null;
  /** The channel the mention was sent in, by name. */
  channelName: string;
  availableActions: MentionActionKind[];
  expiresAt: Date;
};

/**
 * The sender's still-pending mention actions of one message, in the order the body names them:
 * not yet acted on and not expired. What each still allows is read now: Add while the channel is
 * open and the target can join it and is not already a member, and Notify until it was notified,
 * never in a private channel (`notifyMentionTargets` refuses it there).
 */
export async function pendingMentionActionsForMessage(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  message: {
    id: string;
    workspaceId: string;
    conversationId: string;
    senderMemberId: string;
    body: string;
  },
  channel: MentionChannel,
  now: Date = new Date(),
): Promise<PendingMentionActionView[]> {
  const order = leftoverMentionHandles(message.body);
  const rows = await db.pendingMentionAction.findMany({
    where: {
      messageId: message.id,
      senderMemberId: message.senderMemberId,
      resolvedAt: null,
      expiresAt: { gt: now },
    },
    select: PENDING_MENTION_ACTION_SELECT,
  });
  if (!rows.length) return [];
  const members = await db.conversationMember.findMany({
    where: {
      conversationId: message.conversationId,
      ...ACTIVE_MEMBER_WHERE,
      OR: [
        { userId: { in: rows.flatMap((row) => (row.targetUserId ? [row.targetUserId] : [])) } },
        { agentId: { in: rows.flatMap((row) => (row.targetAgentId ? [row.targetAgentId] : [])) } },
      ],
    },
    select: { userId: true, agentId: true },
  });
  const memberIds = new Set(members.map((member) => member.userId ?? member.agentId));
  return rows
    .sort(
      (left, right) =>
        (order.indexOf(left.targetHandle) + 1 || order.length + 1) -
        (order.indexOf(right.targetHandle) + 1 || order.length + 1),
    )
    .map((row) => pendingMentionActionView(row, message.workspaceId, channel, memberIds));
}

const PENDING_MENTION_ACTION_SELECT = {
  id: true,
  messageId: true,
  targetUserId: true,
  targetAgentId: true,
  targetHandle: true,
  expiresAt: true,
  notifiedAt: true,
  workspaceId: true,
  targetUser: {
    select: {
      displayName: true,
      avatarObjectKey: true,
      memberships: { select: { workspaceId: true } },
    },
  },
  targetAgent: {
    select: { displayName: true, avatarMascot: true, visibility: true, deletedAt: true },
  },
} satisfies Prisma.PendingMentionActionSelect;

type PendingMentionActionRow = Prisma.PendingMentionActionGetPayload<{
  select: typeof PENDING_MENTION_ACTION_SELECT;
}>;

function pendingMentionActionView(
  row: PendingMentionActionRow,
  workspaceId: string,
  channel: MentionChannel,
  memberIds: ReadonlySet<string | null>,
): PendingMentionActionView {
  const targetId = (row.targetAgentId ?? row.targetUserId)!;
  const agent = row.targetAgent;
  const canJoin = canJoinChannel({
    targetAgent: agent,
    targetUser: row.targetUser && {
      memberships: row.targetUser.memberships.filter(
        (membership) => membership.workspaceId === row.workspaceId,
      ),
    },
  });
  return {
    resolutionId: row.id,
    messageId: row.messageId,
    targetType: row.targetAgentId ? "agent" : "user",
    targetId,
    targetHandle: row.targetHandle,
    targetLabel: agent
      ? agent.displayName?.trim() || row.targetHandle
      : humanLabel({ displayName: row.targetUser?.displayName }),
    targetAvatarUrl: agent
      ? agentAvatarUrl(targetId, agent.avatarMascot)
      : workspaceUserAvatarUrl(workspaceId, targetId, row.targetUser?.avatarObjectKey ?? null),
    channelName: channel.channelName ?? "",
    // Notify once, add any time: a notified target can still be added. Whether the sender may add
    // is decided when they try.
    availableActions:
      channel.archivedAt === null && canJoin && !memberIds.has(targetId)
        ? row.notifiedAt || !notifyReachesOutside(channel)
          ? ["add"]
          : ["notify", "add"]
        : [],
    expiresAt: row.expiresAt,
  };
}

export type MentionActor = { userId: string } | { agentId: string };

type MentionTarget = {
  conversationId: string;
  targetUserId: string | null;
  targetAgentId: string | null;
};

/** Which of these mentions' targets are already active members of the mention's conversation:
 * ask `has(conversationId, targetId)`. One query for all of them, none when there are none. */
export async function targetMembership(
  db: Pick<PrismaClient, "conversationMember">,
  rows: readonly MentionTarget[],
) {
  const members = rows.length
    ? await db.conversationMember.findMany({
        where: {
          conversationId: { in: [...new Set(rows.map((row) => row.conversationId))] },
          ...ACTIVE_MEMBER_WHERE,
          OR: [
            { userId: { in: rows.flatMap((row) => (row.targetUserId ? [row.targetUserId] : [])) } },
            {
              agentId: {
                in: rows.flatMap((row) => (row.targetAgentId ? [row.targetAgentId] : [])),
              },
            },
          ],
        },
        select: { conversationId: true, userId: true, agentId: true },
      })
    : [];
  const keys = new Set(
    members.map((member) => `${member.conversationId}:${member.userId ?? member.agentId}`),
  );
  return {
    has: (conversationId: string, targetId: string | null) =>
      targetId !== null && keys.has(`${conversationId}:${targetId}`),
  };
}

export type TargetMembership = Awaited<ReturnType<typeof targetMembership>>;

export async function pendingMentionActionsForActor(
  db: Pick<PrismaClient, "pendingMentionAction" | "conversationMember">,
  workspaceId: string,
  sender: MentionActor,
  now: Date = new Date(),
): Promise<PendingMentionActionView[]> {
  const rows = await db.pendingMentionAction.findMany({
    where: {
      workspaceId,
      sender: "userId" in sender ? { userId: sender.userId } : { agentId: sender.agentId },
      resolvedAt: null,
      expiresAt: { gt: now },
    },
    select: {
      ...PENDING_MENTION_ACTION_SELECT,
      conversationId: true,
      createdAt: true,
      message: {
        select: {
          body: true,
          conversation: { select: { channelName: true, archivedAt: true, visibility: true } },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const membership = await targetMembership(db, rows);
  const orderInBody = (row: (typeof rows)[number]) =>
    leftoverMentionHandles(row.message.body).indexOf(row.targetHandle);
  return rows
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        (left.messageId === right.messageId ? orderInBody(left) - orderInBody(right) : 0),
    )
    .map((row) =>
      pendingMentionActionView(
        row,
        workspaceId,
        row.message.conversation,
        new Set(
          [row.targetUserId ?? row.targetAgentId].filter((targetId) =>
            membership.has(row.conversationId, targetId),
          ),
        ),
      ),
    );
}
