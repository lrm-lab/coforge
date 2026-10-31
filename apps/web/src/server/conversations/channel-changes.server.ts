import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { appNotificationsPossible } from "#src/server/app-notifications/app-notifications.server";
import {
  recordChannelArchived,
  recordChannelConfigUpdated,
  recordChannelMembersAdded,
  recordChannelMembersRemoved,
} from "#src/server/app-notifications/channel-events.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { channelActorMemberWhere, type ChannelActor } from "./channel-actor.server";
import { channelPeopleChanged } from "./channel-people-invalidation.server";

/**
 * The writes that change an existing channel or its roster, each recording its app notification
 * event in the same transaction. While no app notification can be recorded
 * (`appNotificationsPossible`) each is the single write it always was; only otherwise does it take
 * an interactive transaction to hold the event beside it.
 */

/**
 * Soft-leaves one member's row (sets `leftAt`) if it is currently active; a no-op (returns
 * `false`) if the row is missing or already left. `PublicChannels.leave` and `removeMember` use
 * it for a human or an Agent, and the Agent CLI's leave and remove-member too.
 */
export async function softLeaveMember(
  db: PrismaClient,
  workspaceId: string,
  conversationId: string,
  actor: ChannelActor,
): Promise<boolean> {
  const where = { conversationId, ...channelActorMemberWhere(actor), ...ACTIVE_MEMBER_WHERE };
  const left = appNotificationsPossible()
    ? await db.$transaction(async (tx) => {
        const result = await tx.conversationMember.updateMany({
          where,
          data: { leftAt: new Date() },
        });
        if (result.count > 0)
          await recordChannelMembersRemoved(tx, workspaceId, [conversationId], actor);
        return result.count > 0;
      })
    : (await db.conversationMember.updateMany({ where, data: { leftAt: new Date() } })).count > 0;
  if (left && "userId" in actor) channelPeopleChanged([conversationId]);
  return left;
}

const infoSelect = {
  id: true,
  channelName: true,
  description: true,
  archivedAt: true,
  visibility: true,
} as const;

/** Writes a channel's new name and/or description; `changed` names the ones that differ. */
export async function updateChannelInfo(
  db: PrismaClient,
  workspaceId: string,
  channelId: string,
  data: { channelName?: string; description?: string },
  changed: { name?: string; description?: string },
) {
  const where = { id: channelId };
  if (!appNotificationsPossible())
    return db.conversation.update({ where, data, select: infoSelect });
  return db.$transaction(async (tx) => {
    const row = await tx.conversation.update({ where, data, select: infoSelect });
    await recordChannelConfigUpdated(tx, workspaceId, { channelId, ...changed });
    return row;
  });
}

/** Archives or unarchives a channel. Only archiving is told to apps. */
export async function setChannelArchived(
  db: PrismaClient,
  workspaceId: string,
  channelId: string,
  archived: boolean,
) {
  const args = {
    where: { id: channelId },
    data: { archivedAt: archived ? new Date() : null },
    select: { channelName: true, description: true, archivedAt: true, visibility: true },
  };
  if (!archived || !appNotificationsPossible()) return db.conversation.update(args);
  return db.$transaction(async (tx) => {
    const row = await tx.conversation.update(args);
    await recordChannelArchived(tx, workspaceId, channelId);
    return row;
  });
}

/**
 * Adds the people and Agents to a channel, a soft-left row coming back with `leftAt` cleared (and,
 * for a person, the read position at the channel's end). Those in `alreadyMember*` are active
 * members already: a person is left alone, an Agent's row is touched with no change and, like the
 * person, is not told to apps again.
 */
export async function upsertChannelMembers(
  db: PrismaClient,
  channel: { workspaceId: string; channelId: string; readThroughSequence: number },
  input: {
    userIds: readonly string[];
    agentIds: readonly string[];
    alreadyMemberUserIds: readonly string[];
    alreadyMemberAgentIds: readonly string[];
  },
): Promise<void> {
  const { workspaceId, channelId, readThroughSequence } = channel;
  const alreadyUsers = new Set(input.alreadyMemberUserIds);
  const alreadyAgents = new Set(input.alreadyMemberAgentIds);
  const write = (client: Prisma.TransactionClient | PrismaClient) =>
    Promise.all([
      ...input.userIds.map((userId) =>
        alreadyUsers.has(userId)
          ? Promise.resolve()
          : client.conversationMember.upsert({
              where: { conversationId_userId: { conversationId: channelId, userId } },
              create: { workspaceId, conversationId: channelId, userId, readThroughSequence },
              update: { leftAt: null, readThroughSequence },
            }),
      ),
      ...input.agentIds.map((agentId) =>
        client.conversationMember.upsert({
          where: { conversationId_agentId: { conversationId: channelId, agentId } },
          create: { workspaceId, conversationId: channelId, agentId },
          update: { leftAt: null },
        }),
      ),
    ]);
  const joiningUserIds = input.userIds.filter((userId) => !alreadyUsers.has(userId));
  try {
    if (!appNotificationsPossible()) await write(db);
    else
      await db.$transaction(async (tx) => {
        await write(tx);
        await recordChannelMembersAdded(tx, workspaceId, channelId, [
          ...joiningUserIds.map((userId) => ({ userId })),
          ...input.agentIds
            .filter((agentId) => !alreadyAgents.has(agentId))
            .map((agentId) => ({ agentId })),
        ]);
      });
  } finally {
    // Without a transaction, some upserts may land before another fails.
    if (joiningUserIds.length) channelPeopleChanged([channelId]);
  }
}
