import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { appNotificationsPossible } from "#src/server/app-notifications/app-notifications.server";
import { recordChannelMembersAdded } from "#src/server/app-notifications/channel-events.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";

/**
 * An Agent joins a channel by itself (the Agent CLI's `channel join`): a first membership, or a
 * re-join through a soft-left row, which clears `leftAt` and keeps the row's settings. Returns
 * whether it joined, `false` when it already was in. While no app notification can be recorded it
 * is the two statements it always was; otherwise they share a transaction with
 * `channel.member_added`.
 */
export async function joinChannelAsAgent(
  db: PrismaClient,
  workspaceId: string,
  channelId: string,
  agentId: string,
): Promise<boolean> {
  const join = async (client: PrismaClient | Prisma.TransactionClient) => {
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
  if (!appNotificationsPossible()) return join(db);
  return db.$transaction(async (tx) => {
    const joined = await join(tx);
    if (joined) await recordChannelMembersAdded(tx, workspaceId, channelId, [{ agentId }]);
    return joined;
  });
}
