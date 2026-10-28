import type { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import {
  activeUserMember,
  getAgentChannel,
  memberChannel,
  type PublicChannelPorts,
} from "./channel-access.server";
import { lockConversation } from "./conversation-lock.server";
import { lockMemberPins, setConversationPin } from "./conversation-pins.server";
import { announceViewerEvent } from "./conversation-realtime.server";
import { humanReadState, markUnreadAnchor } from "./human-unread.server";

/**
 * One member's own settings for a channel: mute, folding long messages, pin, mark unread, and
 * close. Each changes that member's row only; a write that changed nothing announces nothing.
 */

/**
 * Sets fields on a person's active membership row unless they already hold `unless` (always,
 * without it), and says whether anything changed, so an unchanged write announces nothing. A person who is not an active
 * member is refused with `ACCESS_DENIED`.
 */
async function changeMemberRow(
  tx: Prisma.TransactionClient,
  member: { conversationId: string; userId: string },
  change: {
    unless?: Prisma.ConversationMemberWhereInput;
    data: Prisma.ConversationMemberUpdateManyMutationInput;
  },
): Promise<boolean> {
  const where = { ...member, ...ACTIVE_MEMBER_WHERE };
  const updated = await tx.conversationMember.updateMany({
    where: change.unless ? { ...where, NOT: change.unless } : where,
    data: change.data,
  });
  if (updated.count > 0) return true;
  if ((await tx.conversationMember.count({ where })) === 0) throw new AppError("ACCESS_DENIED");
  return false;
}

export async function setAgentMuted(
  { db }: PublicChannelPorts,
  workspaceId: string,
  agentId: string,
  target: string,
  muted: boolean,
) {
  const channel = await getAgentChannel(db, workspaceId, agentId, target);
  await db.$transaction(async (tx) => {
    // The same conversation lock orders preference changes against message creation.
    await lockConversation(tx, channel.id);
    await tx.conversationMember.update({
      where: {
        conversationId_agentId: { conversationId: channel.id, agentId },
      },
      data: { channelMuted: muted },
    });
  });
  return { muted };
}

export async function setUserMuted(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  muted: boolean,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  const changed = await db.$transaction(async (tx) => {
    await lockConversation(tx, channel.id);
    return changeMemberRow(
      tx,
      { conversationId: channel.id, userId },
      {
        unless: { channelMuted: muted },
        data: { channelMuted: muted },
      },
    );
  });
  if (changed)
    await announceViewerEvent(realtime, {
      userIds: [userId],
      event: { type: "pref.changed.v1", workspaceId, name: "muted" },
    });
  return { muted };
}

/** Whether long messages fold behind "Show more" in this channel, for this member only. A
 * display preference: nothing else reads it, so it takes no conversation lock. */
export async function setCollapseLongMessages(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  collapseLongMessages: boolean,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  const updated = await db.conversationMember.updateMany({
    where: { conversationId: channel.id, userId, ...ACTIVE_MEMBER_WHERE },
    data: { collapseLongMessages },
  });
  if (updated.count !== 1) throw new AppError("ACCESS_DENIED");
  return { collapseLongMessages };
}

/** Pins this conversation for this member only (see `setConversationPin` for the order).
 * Unpinning removes the row rather than zeroing it, so membership and pin state stay
 * independent of archive/leave (see `ConversationPin`). */
export async function setUserPinned(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  pinned: boolean,
  sortOrder?: number,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  const changed = await db.$transaction(async (tx) => {
    await lockMemberPins(tx, workspaceId, userId);
    await lockConversation(tx, channel.id);
    const member = await activeUserMember(tx, channel.id, userId);
    if (!member) throw new AppError("ACCESS_DENIED");
    return setConversationPin(
      tx,
      { workspaceId, userId, conversationId: channel.id, memberId: member.id },
      pinned,
      sortOrder,
    );
  });
  if (changed)
    await announceViewerEvent(realtime, {
      userIds: [userId],
      event: { type: "pref.changed.v1", workspaceId, name: "pins" },
    });
  return { pinned };
}

/** Marks the conversation unread for this member, or clears the marker. Marking is anchored on
 * the newest top-level message someone else sent, so the badge is at least one; a conversation
 * where only this member has spoken has nothing to mark. */
export async function setUserUnread(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  unread: boolean,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  let marker: number | null = null;
  const changed = await db.$transaction(async (tx) => {
    await lockConversation(tx, channel.id);
    const member = await tx.conversationMember.findFirst({
      where: { conversationId: channel.id, userId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true, unreadFromSequence: true },
    });
    if (!member) throw new AppError("ACCESS_DENIED");
    if (unread) marker = await markUnreadAnchor(tx, channel.id, member.id);
    // Re-checks membership: leaving does not take the conversation lock.
    const updated = await tx.conversationMember.updateMany({
      where: { id: member.id, ...ACTIVE_MEMBER_WHERE },
      data: { unreadFromSequence: marker },
    });
    if (updated.count !== 1) throw new AppError("ACCESS_DENIED");
    return member.unreadFromSequence !== marker;
  });
  if (changed)
    await announceViewerEvent(realtime, {
      userIds: [userId],
      event: {
        type: "channel.marked.v1",
        workspaceId,
        conversationId: channel.id,
        ...(await humanReadState(db, channel.id, userId)),
      },
    });
  return { unread: marker !== null };
}

/** Closes (hides) the conversation for this member only, or brings it back. Distinct from
 * `archivedAt` (whole conversation) and `leftAt` (membership ended): nothing else changes and
 * the conversations stays readable. */
export async function setUserHidden(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  hidden: boolean,
) {
  const channel = await memberChannel(db, workspaceId, userId, channelId);
  const changed = await db.$transaction(async (tx) => {
    await lockConversation(tx, channel.id);
    return changeMemberRow(
      tx,
      { conversationId: channel.id, userId },
      {
        // Closing always stamps the time: a closed chat that someone's newer message brought
        // back still has an old `hiddenAt`, and closing it again must move it past that message.
        ...(hidden ? {} : { unless: { hiddenAt: null } }),
        data: { hiddenAt: hidden ? new Date() : null },
      },
    );
  });
  if (changed)
    await announceViewerEvent(realtime, {
      userIds: [userId],
      event: {
        type: hidden ? "channel.closed.v1" : "channel.opened.v1",
        workspaceId,
        conversationId: channel.id,
      },
    });
  return { hidden };
}
