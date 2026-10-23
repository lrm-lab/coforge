import type { Prisma } from "#src/generated/prisma/client";
import type { AppNotificationEventPayload } from "./app-notification-event";
import { recordAppNotifications } from "./app-notifications.server";

/**
 * What apps are told about a Workspace's channels (every channel is Workspace-visible) and their
 * threads. Each function runs inside the transaction of the domain write it describes, so the
 * event exists only if that write commits; the data is ids and the changed fields, never message
 * content. A caller that changes several memberships builds one list and records it once, so the
 * Workspace is read once.
 */

/** Who a channel membership event is about: a person (by Workspace user id) or an Agent. */
export type ChannelMember = { userId: string } | { agentId: string };

const memberData = (member: ChannelMember) =>
  "userId" in member ? { user_id: member.userId } : { agent_id: member.agentId };

/** One membership event of `type` for each pairing of the channels and the members. */
export function channelMemberEvents(
  type: "channel.member_added" | "channel.member_removed",
  channelIds: readonly string[],
  ...members: readonly ChannelMember[]
): AppNotificationEventPayload[] {
  return channelIds.flatMap((channel_id) =>
    members.map((member) => ({ type, data: { channel_id, ...memberData(member) } })),
  );
}

/** A new channel, and its creator, who is its first member. */
export function recordChannelCreated(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  channel: { id: string; name: string; creator: ChannelMember },
) {
  return recordAppNotifications(tx, { id: workspaceId }, [
    {
      type: "workspace.public_channel_created",
      data: { channel_id: channel.id, name: channel.name },
    },
    ...channelMemberEvents("channel.member_added", [channel.id], channel.creator),
  ]);
}

export function recordChannelArchived(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  channelId: string,
) {
  return recordAppNotifications(tx, { id: workspaceId }, [
    { type: "workspace.public_channel_archived", data: { channel_id: channelId } },
    { type: "channel.archived", data: { channel_id: channelId } },
  ]);
}

/** A rename and/or a new description; a value that did not change is not passed. */
export function recordChannelConfigUpdated(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  change: { channelId: string; name?: string; description?: string },
) {
  const fields = (["name", "description"] as const).filter((field) => change[field] !== undefined);
  if (fields.length === 0) return Promise.resolve();
  return recordAppNotifications(tx, { id: workspaceId }, [
    {
      type: "channel.config_updated",
      data: {
        channel_id: change.channelId,
        fields,
        ...(change.name !== undefined ? { name: change.name } : {}),
      },
    },
  ]);
}

/** Members who became active members of the channel (not those already in it). */
export function recordChannelMembersAdded(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  channelId: string,
  members: readonly ChannelMember[],
) {
  return recordAppNotifications(
    tx,
    { id: workspaceId },
    channelMemberEvents("channel.member_added", [channelId], ...members),
  );
}

/** Members whose active membership of one or more channels ended. */
export function recordChannelMembersRemoved(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  channelIds: readonly string[],
  member: ChannelMember,
) {
  return recordAppNotifications(
    tx,
    { id: workspaceId },
    channelMemberEvents("channel.member_removed", channelIds, member),
  );
}

/**
 * A reply in a channel was just written as `messageId` under `threadRootId`: when no other reply
 * to that root exists, it is the one that made the thread. The sender's transaction holds the
 * channel's lock, so two first replies cannot both see none. Call it for channel replies only. The
 * check is the emitter's own query: it runs only once the flag is on for the Workspace, in a
 * savepoint.
 */
export function recordThreadCreatedByReply(
  tx: Prisma.TransactionClient,
  reply: { workspaceId: string; channelId: string; threadRootId: string; messageId: string },
) {
  return recordAppNotifications(tx, { id: reply.workspaceId }, async () => {
    const earlier = await tx.message.findFirst({
      where: {
        conversationId: reply.channelId,
        threadRootId: reply.threadRootId,
        id: { not: reply.messageId },
      },
      select: { id: true },
    });
    if (earlier) return [];
    return [
      {
        type: "thread.created",
        data: {
          channel_id: reply.channelId,
          thread_root_id: reply.threadRootId,
          message_id: reply.messageId,
        },
      },
    ];
  });
}
