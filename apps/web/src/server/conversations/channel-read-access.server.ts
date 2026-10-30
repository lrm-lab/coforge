import { Prisma } from "#src/generated/prisma/client";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "./active-member.server";
import { channelActorMemberWhere, type ChannelActor } from "./channel-actor.server";

/**
 * The one rule for reading a channel, as a query, as raw SQL and in memory; every channel read
 * applies one of the three, and `channel-read-access.integration.test.ts` holds them to the same
 * answer.
 *
 * A public channel is readable by every Workspace member and every Agent of the Workspace; a
 * private one only by its active members (`ACTIVE_MEMBER_WHERE`). A Workspace role grants nothing
 * here: an owner or admin outside a private channel does not see it. The caller has already
 * established that the reader belongs to the Workspace (`authorizeChannelActor`). A channel hidden
 * from the Workspace (`VISIBLE_CONVERSATION_WHERE`) and a DM are never read.
 *
 * The rule sits under `AND`, so a caller's own `OR` spread beside it narrows the read and can
 * never replace it; a caller with its own `AND` nests both instead of spreading.
 */
export function visibleChannelWhere(workspaceId: string, reader: ChannelActor) {
  return {
    workspaceId,
    channelName: { not: null },
    ...VISIBLE_CONVERSATION_WHERE,
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

/** `visibleChannelWhere` for a channel already read: `isActiveMember` is whether the reader has
 * an active member row in it. */
export function canReadChannel(channel: { visibility: string }, isActiveMember: boolean) {
  return channel.visibility === CHANNEL_VISIBILITY.PUBLIC || isActiveMember;
}

/** The conversations a person acts on a message in (save, react, download a file): a channel by
 * `visibleChannelWhere`, or a DM, which the caller still checks is theirs by their member row. */
export function readableConversationWhere(workspaceId: string, reader: { userId: string }) {
  return {
    AND: [
      {
        OR: [
          visibleChannelWhere(workspaceId, reader),
          { ...VISIBLE_CONVERSATION_WHERE, ...DIRECT_CONVERSATION_WHERE },
        ],
      },
    ],
  } satisfies Prisma.ConversationWhereInput;
}

/** `visibleChannelWhere` for a raw query over `"conversations" <alias>`; the alias is a
 * repository-owned identifier. */
export function readableChannelSql(alias: string, workspaceId: string, reader: ChannelActor) {
  const conversation = Prisma.raw(alias);
  const readerColumn = Prisma.raw("userId" in reader ? '"userId"' : '"agentId"');
  const readerId = "userId" in reader ? reader.userId : reader.agentId;
  return Prisma.sql`(${conversation}."workspaceId" = ${workspaceId}::uuid
    AND ${conversation}."channelName" IS NOT NULL
    AND ${conversation}."hiddenFromWorkspaceAt" IS NULL
    AND (${conversation}."visibility" = ${CHANNEL_VISIBILITY.PUBLIC} OR EXISTS (
      SELECT 1 FROM "conversation_members" reader
      WHERE reader."conversationId" = ${conversation}."id"
        AND reader."workspaceId" = ${workspaceId}::uuid
        AND reader.${readerColumn} = ${readerId}::uuid
        AND reader."leftAt" IS NULL)))`;
}
