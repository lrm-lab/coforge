import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "./active-member.server";
import { taskDiscussionAccess, taskDiscussionBoardSelect } from "./task-discussion-access.server";
import { channelActorMemberWhere, type ChannelActor } from "./channel-actor.server";

/**
 * The one rule for reading a channel, as a query, as raw SQL, in memory and by id; every channel
 * read applies one of the four, and `channel-read-access.integration.test.ts` holds them to the
 * same answer.
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
    ...channelWhere(workspaceId),
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

/** Every channel of the Workspace a read may ever reach: not a DM, not hidden. */
function channelWhere(workspaceId: string) {
  return {
    workspaceId,
    channelName: { not: null },
    ...VISIBLE_CONVERSATION_WHERE,
  } satisfies Prisma.ConversationWhereInput;
}

/**
 * The by-id form, for a single-channel read on a hot path: `channelByIdWhere` reads the channel
 * without `visibleChannelWhere`'s member probe, and `requireReadableChannel` then applies the
 * rule, probing the reader's member row only for a private channel. The read must select
 * `visibility` and go through `requireReadableChannel`.
 */
export function channelByIdWhere(workspaceId: string, channelId: string) {
  return { id: channelId, ...channelWhere(workspaceId) } satisfies Prisma.ConversationWhereInput;
}

/** A channel read through `channelByIdWhere`, or `NOT_FOUND`: a missing channel and one the
 * reader cannot read answer alike. */
export async function requireReadableChannel<Channel extends { id: string; visibility: string }>(
  db: Pick<PrismaClient, "conversationMember">,
  workspaceId: string,
  reader: ChannelActor,
  channel: Channel | null,
): Promise<Channel> {
  if (!channel) throw new AppError("NOT_FOUND");
  if (canReadChannel(channel, false)) return channel;
  const member = await db.conversationMember.findFirst({
    where: {
      conversationId: channel.id,
      workspaceId,
      ...channelActorMemberWhere(reader),
      ...ACTIVE_MEMBER_WHERE,
    },
    select: { id: true },
  });
  if (!canReadChannel(channel, member !== null)) throw new AppError("NOT_FOUND");
  return channel;
}

/** `visibleChannelWhere` for a channel already read: `isActiveMember` is whether the reader has
 * an active member row in it. */
export function canReadChannel(channel: { visibility: string }, isActiveMember: boolean) {
  return channel.visibility === CHANNEL_VISIBILITY.PUBLIC || isActiveMember;
}

/** The shared in-memory read rule for an artifact's conversation home. */
export function canReadConversationHome(input: {
  channelName: string | null;
  visibility: string;
  member: boolean;
}) {
  return input.channelName === null ? input.member : canReadChannel(input, input.member);
}

/**
 * Whether a person reads one conversation, for a gate that has only its id (a realtime
 * subscription, a file download): a DM they are an active member of, or a channel of a Workspace
 * they belong to that `canReadChannel` lets them read; never a hidden one. `"private"` is a
 * private channel they are not in, which a caller that keeps such a channel unknown reports as
 * missing; `undefined` is none of these. `where` narrows which conversation is meant.
 */
export async function personConversationAccess(
  db: Pick<PrismaClient, "conversation">,
  userId: string,
  where: Prisma.ConversationWhereInput,
): Promise<"read" | "private" | undefined> {
  const conversation = await db.conversation.findFirst({
    where: {
      AND: [where],
      ...VISIBLE_CONVERSATION_WHERE,
      OR: [
        { ...DIRECT_CONVERSATION_WHERE, members: { some: { userId, ...ACTIVE_MEMBER_WHERE } } },
        { channelName: { not: null }, workspace: { members: { some: { userId } } } },
        // A task's own conversation: its board decides (`taskDiscussionAccess`).
        { kind: "task_thread", workspace: { members: { some: { userId } } } },
      ],
    },
    select: {
      channelName: true,
      visibility: true,
      kind: true,
      members: { where: { userId, ...ACTIVE_MEMBER_WHERE }, select: { id: true } },
      ...taskDiscussionBoardSelect({ userId }),
    },
  });
  if (!conversation) return undefined;
  if (conversation.kind === "task_thread") return taskDiscussionAccess(conversation);
  if (conversation.channelName === null) return "read";
  return canReadChannel(conversation, conversation.members.length > 0) ? "read" : "private";
}

/**
 * What `actor` — a person or an Agent — may do in one channel or DM, for a caller that holds
 * only the conversation's id and must not read the conversation tables itself (the artifacts
 * module's home rule, task #542): `read` is `canReadChannel`'s answer — a DM's active members
 * only — `write` adds an unarchived home, and `kind` names which it is. `undefined` is a
 * conversation the Workspace cannot see or that is not a channel or a DM.
 */
export async function actorConversationAccess(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  actor: ChannelActor,
  conversationId: string,
): Promise<{ read: boolean; write: boolean; kind: "channel" | "dm" } | undefined> {
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      workspaceId,
      ...VISIBLE_CONVERSATION_WHERE,
      OR: [{ channelName: { not: null } }, DIRECT_CONVERSATION_WHERE],
    },
    select: {
      channelName: true,
      visibility: true,
      archivedAt: true,
      members: {
        where: { ...channelActorMemberWhere(actor), ...ACTIVE_MEMBER_WHERE },
        select: { id: true },
      },
    },
  });
  if (!conversation) return undefined;
  const member = conversation.members.length > 0;
  return {
    read: canReadConversationHome({
      channelName: conversation.channelName,
      visibility: conversation.visibility,
      member,
    }),
    write: member && conversation.archivedAt === null,
    kind: conversation.channelName === null ? "dm" : "channel",
  };
}

/** Whether the Workspace hides this conversation from everyone (`hiddenFromWorkspaceAt`), for a
 * caller that must treat the conversation's artifacts as absent too (the artifacts module's home
 * rule, task #20). `false` for a missing conversation or a DM, which is never hidden. */
export async function conversationHiddenFromWorkspace(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  conversationId: string,
) {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { hiddenFromWorkspaceAt: true },
  });
  return conversation?.hiddenFromWorkspaceAt != null;
}

/** Which of the listed conversations the Workspace hides, as one read for a batch of artifact
 * homes (task #20). Missing ids and DMs are simply absent from the set. */
export async function hiddenFromWorkspaceConversationIds(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  conversationIds: readonly string[],
): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const conversations = await db.conversation.findMany({
    where: {
      workspaceId,
      id: { in: [...conversationIds] },
      hiddenFromWorkspaceAt: { not: null },
    },
    select: { id: true },
  });
  return new Set(conversations.map((conversation) => conversation.id));
}

/** What `actor` may read of each listed channel or DM home, batched for card projections
 * (task #20): per conversation id, the fields `canReadConversationHome` reads, whether the
 * actor is an active member, whether the Workspace hides it, and which kind it is. Unlike
 * `actorConversationAccess` this keeps hidden conversations, flagged `hidden`, so a caller
 * can tell "gone for everyone" from "not there"; a missing id is simply absent from the map. */
export async function actorConversationHomeReads(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  actor: ChannelActor,
  conversationIds: readonly string[],
): Promise<
  Map<
    string,
    {
      channelName: string | null;
      visibility: string;
      member: boolean;
      hidden: boolean;
      kind: "channel" | "dm";
    }
  >
> {
  if (conversationIds.length === 0) return new Map();
  const conversations = await db.conversation.findMany({
    where: {
      workspaceId,
      id: { in: [...conversationIds] },
      OR: [{ channelName: { not: null } }, DIRECT_CONVERSATION_WHERE],
    },
    select: {
      id: true,
      channelName: true,
      visibility: true,
      hiddenFromWorkspaceAt: true,
      members: {
        where: { ...channelActorMemberWhere(actor), ...ACTIVE_MEMBER_WHERE },
        select: { id: true },
      },
    },
  });
  return new Map(
    conversations.map((conversation) => [
      conversation.id,
      {
        channelName: conversation.channelName,
        visibility: conversation.visibility,
        member: conversation.members.length > 0,
        hidden: conversation.hiddenFromWorkspaceAt !== null,
        kind: conversation.channelName === null ? ("dm" as const) : ("channel" as const),
      },
    ]),
  );
}

/** The id of the Workspace's channel named `name`, hidden ones aside — a lookup, not a read
 * grant: the caller applies its own access rule (the artifacts module's `#channel` target,
 * task #542). `undefined` when no such channel exists. */
export async function visibleChannelIdByName(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  channelName: string,
) {
  const channel = await db.conversation.findFirst({
    where: { workspaceId, channelName, ...VISIBLE_CONVERSATION_WHERE },
    select: { id: true },
  });
  return channel?.id;
}

/** The id of the direct conversation `memberA` and `memberB` share, both actively seated — a
 * lookup, never an open: a DM that does not exist answers `undefined` (the artifacts module's
 * `@name` target, task #542). */
export async function directConversationIdBetween(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  memberA: ChannelActor,
  memberB: ChannelActor,
) {
  const conversation = await db.conversation.findFirst({
    where: {
      workspaceId,
      ...DIRECT_CONVERSATION_WHERE,
      AND: [
        { members: { some: { ...channelActorMemberWhere(memberA), ...ACTIVE_MEMBER_WHERE } } },
        { members: { some: { ...channelActorMemberWhere(memberB), ...ACTIVE_MEMBER_WHERE } } },
      ],
    },
    select: { id: true },
  });
  return conversation?.id;
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
          // A task's own conversation: readable as its board is, never by its own seats.
          {
            kind: "task_thread",
            taskDiscussionOf: {
              conversation: {
                OR: [
                  visibleChannelWhere(workspaceId, reader),
                  {
                    ...VISIBLE_CONVERSATION_WHERE,
                    ...DIRECT_CONVERSATION_WHERE,
                    members: {
                      some: { workspaceId, userId: reader.userId, ...ACTIVE_MEMBER_WHERE },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  } satisfies Prisma.ConversationWhereInput;
}

/** A conversation a person may read, for a raw query over `"conversations" <alias>`: a channel by
 * `readableChannelSql`, a direct conversation only while they are an active member of it. */
export function readablePersonConversationSql(alias: string, workspaceId: string, userId: string) {
  const conversation = Prisma.raw(alias);
  return Prisma.sql`(${readableChannelSql(alias, workspaceId, { userId })}
    OR ${conversation}."directKey" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "conversation_members" v
    WHERE v."conversationId" = ${conversation}."id" AND v."userId" = ${userId}::uuid
      AND v."leftAt" IS NULL))`;
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
