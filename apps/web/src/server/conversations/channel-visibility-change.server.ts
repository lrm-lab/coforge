import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  CHANNEL_VISIBILITY,
  channelVisibilityOf,
  type ChannelVisibility,
} from "#src/features/conversations/channel-visibility";
import { appNotificationsPossible } from "#src/server/app-notifications/app-notifications.server";
import { recordChannelMadePublic } from "#src/server/app-notifications/channel-events.server";
import { errorType } from "#src/server/errors/error-type.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import type { PublicChannelPorts } from "./channel-access.server";
import type { ChannelActor } from "./channel-actor.server";
import { canChangeChannelVisibility, resolveChannelAuthority } from "./channel-authority.server";
import { announceConversationsRevoked } from "./channel-membership-signals.server";
import { channelPeopleChanged } from "./channel-people-invalidation.server";
import { channelByIdWhere, requireReadableChannel } from "./channel-read-access.server";
import {
  announceChannelCreated,
  announceChannelUpdated,
  channelInfoOf,
} from "./conversation-realtime.server";

const CHANNEL_SELECT = {
  id: true,
  channelName: true,
  description: true,
  archivedAt: true,
  visibility: true,
} as const;

type VisibilityChannel = Prisma.ConversationGetPayload<{ select: typeof CHANNEL_SELECT }>;
type VisibilityPorts = Pick<PublicChannelPorts, "db" | "realtime">;

/**
 * Makes a channel private or public (task #302), for a person (`PublicChannels.setVisibility`) and
 * an Agent (`AgentChannelManagement.update`). Reading comes first: a private channel the actor
 * cannot read is missing (`NOT_FOUND`). Then only a Workspace owner or admin who is in the channel
 * changes it (`canChangeChannelVisibility`, `ACCESS_DENIED`); `#general` is always public and an
 * archived channel changes nothing (`CONFLICT`). The visibility it already has changes nothing and
 * announces nothing.
 *
 * Made private, its members keep it and everyone else loses it at once: the live Activity audience
 * forgets it (`channelPeopleChanged`), their subscriptions to it and its Tasks' conversations end
 * (`announceConversationsRevoked`), their lists drop it (`gone`), and its members' lists show it
 * private. Made public, everyone's lists show it and apps see it from then on. Every other read
 * applies the rule when it runs, so nothing else remembers the old answer.
 */
export async function setChannelVisibility(
  { db, realtime }: VisibilityPorts,
  workspaceId: string,
  actor: ChannelActor,
  channelId: string,
  visibility: ChannelVisibility,
): Promise<{ changed: boolean }> {
  const channel = await requireReadableChannel(
    db,
    workspaceId,
    actor,
    await db.conversation.findFirst({
      where: channelByIdWhere(workspaceId, channelId),
      select: CHANNEL_SELECT,
    }),
  );
  const authority = await resolveChannelAuthority(db, workspaceId, actor, channel);
  if (channel.channelName === "general") throw new AppError("CONFLICT");
  if (
    !canChangeChannelVisibility(
      channel.channelName!,
      authority.serverRole,
      authority.isActiveMember,
    )
  )
    throw new AppError("ACCESS_DENIED");
  if (channel.archivedAt) throw new AppError("CONFLICT");
  if (channelVisibilityOf(channel) === visibility) return { changed: false };
  // A concurrent change that got there first wins; this one then changed nothing.
  if (!(await writeVisibility(db, workspaceId, channel, visibility))) return { changed: false };
  channelPeopleChanged([channel.id]);
  await announceVisibility({ db, realtime }, workspaceId, { ...channel, visibility });
  return { changed: true };
}

async function writeVisibility(
  db: PrismaClient,
  workspaceId: string,
  channel: VisibilityChannel,
  visibility: ChannelVisibility,
) {
  const write = (client: Prisma.TransactionClient | PrismaClient) =>
    client.conversation.updateMany({
      where: { id: channel.id, visibility: channel.visibility },
      data: { visibility },
    });
  if (!appNotificationsPossible()) return (await write(db)).count > 0;
  return db.$transaction(async (tx) => {
    const { count } = await write(tx);
    if (count > 0 && visibility === CHANNEL_VISIBILITY.PUBLIC)
      await recordChannelMadePublic(tx, workspaceId, {
        id: channel.id,
        name: channel.channelName!,
      });
    return count > 0;
  });
}

async function announceVisibility(
  { db, realtime }: VisibilityPorts,
  workspaceId: string,
  channel: VisibilityChannel,
) {
  const conversationId = channel.id;
  // Read as the write left it. A switch back since announces itself, so this one stands down;
  // a failed read announces nothing rather than take the channel from its own members (an
  // outsider's subscriptions then end at their next token renewal, which the read rule refuses).
  // Its people are read only when private: a public channel's roster may be the whole Workspace.
  const now = await db.conversation
    .findUnique({
      where: { id: conversationId },
      select: {
        visibility: true,
        members:
          channel.visibility === CHANNEL_VISIBILITY.PRIVATE
            ? { where: { userId: { not: null }, ...ACTIVE_MEMBER_WHERE }, select: { userId: true } }
            : false,
      },
    })
    .catch((error: unknown) => {
      console.warn(
        JSON.stringify({ event: "channel_visibility:read_failed", error_type: errorType(error) }),
      );
      return null;
    });
  if (now?.visibility !== channel.visibility) return;
  const info = channelInfoOf(channel);
  if (channel.visibility === CHANNEL_VISIBILITY.PUBLIC) {
    // Everyone's lists gain it as a channel they may now read; its own page shows it public.
    await Promise.all([
      announceChannelCreated(realtime, {
        workspaceId,
        conversationId,
        channel: info,
        memberUserIds: undefined,
      }),
      announceChannelUpdated(realtime, {
        workspaceId,
        conversationId,
        channel: info,
        memberUserIds: undefined,
      }),
    ]);
    return;
  }
  const memberUserIds = (now.members ?? []).flatMap(({ userId }) => (userId ? [userId] : []));
  const inChannel = new Set(memberUserIds);
  const people = await db.workspaceMembership.findMany({
    where: { workspaceId },
    select: { userId: true },
  });
  const outsiders = people.flatMap(({ userId }) => (inChannel.has(userId) ? [] : [userId]));
  // Outsiders' subscriptions end first, so the channel's own event reaches its members only.
  await announceConversationsRevoked(realtime, {
    workspaceId,
    db,
    userIds: outsiders,
    conversationIds: [conversationId],
  });
  await Promise.all([
    announceChannelUpdated(realtime, {
      workspaceId,
      conversationId,
      gone: true,
      memberUserIds: outsiders,
    }),
    announceChannelUpdated(realtime, { workspaceId, conversationId, channel: info, memberUserIds }),
  ]);
}
