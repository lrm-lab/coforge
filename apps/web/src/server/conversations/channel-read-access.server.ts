import type { Prisma } from "#src/generated/prisma/client";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { visibleChannelWhere, type ChannelActor } from "./channel-access.server";
import { channelActorMemberWhere } from "./channel-authority.server";

/**
 * The one rule for reading a channel, as a query and in memory; every channel read applies one of
 * the two, and `channel-read-access.integration.test.ts` holds them to the same answer.
 *
 * A public channel is readable by every Workspace member and every Agent of the Workspace; a
 * private one only by its active members (`ACTIVE_MEMBER_WHERE`). A Workspace role grants nothing
 * here: an owner or admin outside a private channel does not see it. The caller has already
 * established that the reader belongs to the Workspace (`authorizeChannelActor`).
 *
 * The rule sits under `AND`, so a caller's own `OR` spread beside it narrows the read and can
 * never replace it; a caller with its own `AND` nests both instead of spreading.
 */
export function readableChannelWhere(workspaceId: string, reader: ChannelActor) {
  return {
    ...visibleChannelWhere(workspaceId),
    AND: [
      {
        OR: [
          { visibility: CHANNEL_VISIBILITY.PUBLIC },
          {
            members: {
              some: { workspaceId, ...channelActorMemberWhere(reader), ...ACTIVE_MEMBER_WHERE },
            },
          },
        ],
      },
    ],
  } satisfies Prisma.ConversationWhereInput;
}

/** `readableChannelWhere` for a channel already read: `isActiveMember` is whether the reader has
 * an active member row in it. */
export function canReadChannel(channel: { visibility: string }, isActiveMember: boolean) {
  return channel.visibility === CHANNEL_VISIBILITY.PUBLIC || isActiveMember;
}
