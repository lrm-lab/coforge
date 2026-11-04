import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { appNotificationsPossible } from "#src/server/app-notifications/app-notifications.server";
import { recordChannelMembersAdded } from "#src/server/app-notifications/channel-events.server";
import {
  recordMembershipNotice,
  type MembershipNoticeRef,
} from "#src/server/conversations/channel-membership-notice.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";

/**
 * An Agent joins a channel by itself (the Agent CLI's `channel join`): a first membership, or a
 * re-join through a soft-left row, which clears `leftAt` and keeps the row's settings. Returns
 * whether it joined and the system record it posted, for the caller to signal after the commit.
 * The membership record writes either way; the app notification lands only while one is possible.
 */
export async function joinChannelAsAgent(
  db: PrismaClient,
  workspaceId: string,
  channelId: string,
  agentId: string,
): Promise<{ joined: boolean; notice: MembershipNoticeRef | null }> {
  return db.$transaction((tx) => joinChannelAsAgentIn(tx, workspaceId, channelId, agentId));
}

const joinMembership = async (
  client: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  channelId: string,
  agentId: string,
) => {
  const active = await client.conversationMember.findFirst({
    where: { conversationId: channelId, agentId, ...ACTIVE_MEMBER_WHERE },
    select: { id: true },
  });
  await client.conversationMember.upsert({
    where: { conversationId_agentId: { conversationId: channelId, agentId } },
    create: { conversationId: channelId, workspaceId, agentId },
    update: { leftAt: null },
  });
  return !active;
};

/**
 * `joinChannelAsAgent`'s write inside a transaction its caller already holds: a send joins the
 * channel and posts in one transaction, so a send that fails leaves no membership. The
 * `channel.member_added` recording is the same one `channel join` makes.
 */
export async function joinChannelAsAgentIn(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  channelId: string,
  agentId: string,
): Promise<{ joined: boolean; notice: MembershipNoticeRef | null }> {
  const joined = await joinMembership(tx, workspaceId, channelId, agentId);
  if (joined && appNotificationsPossible())
    await recordChannelMembersAdded(tx, workspaceId, channelId, [{ agentId }]);
  const notice = joined
    ? await recordMembershipNotice(tx, {
        workspaceId,
        conversationId: channelId,
        kind: "channel.member_joined",
        actors: [{ agentId }],
      })
    : null;
  return { joined, notice };
}
