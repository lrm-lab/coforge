import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  ACTIVE_MEMBER_WHERE,
  DIRECT_CONVERSATION_WHERE,
  directConversationSql,
  VISIBLE_CONVERSATION_WHERE,
} from "./active-member.server";
import { taskDiscussionAccess, taskDiscussionBoardSelect } from "./task-discussion-access.server";
import { channelActorMemberWhere, type ChannelActor } from "./channel-actor.server";

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

function channelWhere(workspaceId: string) {
  return {
    workspaceId,
    channelName: { not: null },
    ...VISIBLE_CONVERSATION_WHERE,
  } satisfies Prisma.ConversationWhereInput;
}

export function channelByIdWhere(workspaceId: string, channelId: string) {
  return { id: channelId, ...channelWhere(workspaceId) } satisfies Prisma.ConversationWhereInput;
}

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

export function canReadChannel(channel: { visibility: string }, isActiveMember: boolean) {
  return channel.visibility === CHANNEL_VISIBILITY.PUBLIC || isActiveMember;
}

export function canReadConversationHome(input: {
  channelName: string | null;
  visibility: string;
  member: boolean;
}) {
  return input.channelName === null ? input.member : canReadChannel(input, input.member);
}

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

export type ActorConversationHomeRead = {
  channelName: string | null;
  visibility: string;
  member: boolean;
  hidden: boolean;
  kind: "channel" | "dm";
};

export async function actorConversationHomeReads(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  actor: ChannelActor,
  conversationIds: readonly string[],
): Promise<Map<string, ActorConversationHomeRead>> {
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

export async function agentsConversationHomeReads(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  conversationId: string,
  agentIds: readonly string[],
): Promise<Map<string, ActorConversationHomeRead> | undefined> {
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      workspaceId,
      OR: [{ channelName: { not: null } }, DIRECT_CONVERSATION_WHERE],
    },
    select: {
      channelName: true,
      visibility: true,
      hiddenFromWorkspaceAt: true,
      members: {
        where: { agentId: { in: [...agentIds] }, ...ACTIVE_MEMBER_WHERE },
        select: { agentId: true },
      },
    },
  });
  if (!conversation) return undefined;
  const seated = new Set(conversation.members.map((member) => member.agentId));
  return new Map(
    agentIds.map((agentId) => [
      agentId,
      {
        channelName: conversation.channelName,
        visibility: conversation.visibility,
        member: seated.has(agentId),
        hidden: conversation.hiddenFromWorkspaceAt !== null,
        kind: conversation.channelName === null ? ("dm" as const) : ("channel" as const),
      },
    ]),
  );
}

export function actorConversationHomeSql(alias: string, workspaceId: string, actor: ChannelActor) {
  const conversation = Prisma.raw(alias);
  const seatColumn = Prisma.raw("userId" in actor ? '"userId"' : '"agentId"');
  const actorId = "userId" in actor ? actor.userId : actor.agentId;
  const stands = Prisma.sql`(${conversation}."workspaceId" = ${workspaceId}::uuid
    AND (${conversation}."channelName" IS NOT NULL OR ${directConversationSql(alias)})
    AND ${conversation}."hiddenFromWorkspaceAt" IS NULL)`;
  const seated = Prisma.sql`EXISTS (
    SELECT 1 FROM "conversation_members" seat
    WHERE seat."conversationId" = ${conversation}."id"
      AND seat.${seatColumn} = ${actorId}::uuid
      AND seat."leftAt" IS NULL)`;
  const reads = Prisma.sql`(${stands} AND (
    (${conversation}."channelName" IS NULL AND ${seated})
    OR (${conversation}."channelName" IS NOT NULL
      AND (${conversation}."visibility" = ${CHANNEL_VISIBILITY.PUBLIC} OR ${seated}))))`;
  return { stands, reads };
}

export async function actorsWithoutConversationRead(
  db: Pick<PrismaClient, "conversation" | "workspaceMembership" | "agent">,
  workspaceId: string,
  conversationId: string,
): Promise<{ people: number; agents: number } | undefined> {
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
      members: { where: ACTIVE_MEMBER_WHERE, select: { userId: true, agentId: true } },
    },
  });
  if (!conversation) return undefined;
  if (conversation.channelName !== null && conversation.visibility === CHANNEL_VISIBILITY.PUBLIC)
    return { people: 0, agents: 0 };
  const seatedPeople = conversation.members.flatMap((member) => member.userId ?? []);
  const seatedAgents = conversation.members.flatMap((member) => member.agentId ?? []);
  const [people, agents] = await Promise.all([
    db.workspaceMembership.count({ where: { workspaceId, userId: { notIn: seatedPeople } } }),
    db.agent.count({ where: { workspaceId, ...ACTIVE_AGENT_WHERE, id: { notIn: seatedAgents } } }),
  ]);
  return { people, agents };
}

export async function membersWithoutOtherConversationRead(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  targetId: string,
  homeId: string,
): Promise<{ people: number; agents: number } | undefined> {
  const [target, home] = await Promise.all(
    [targetId, homeId].map((id) =>
      db.conversation.findFirst({
        where: {
          id,
          workspaceId,
          ...VISIBLE_CONVERSATION_WHERE,
          OR: [{ channelName: { not: null } }, DIRECT_CONVERSATION_WHERE],
        },
        select: {
          channelName: true,
          visibility: true,
          members: { where: ACTIVE_MEMBER_WHERE, select: { userId: true, agentId: true } },
        },
      }),
    ),
  );
  if (!target || !home) return undefined;
  if (home.channelName !== null && home.visibility === CHANNEL_VISIBILITY.PUBLIC)
    return { people: 0, agents: 0 };
  const seated = new Set(home.members.map((member) => member.userId ?? member.agentId));
  const lacking = target.members.filter((member) => !seated.has(member.userId ?? member.agentId));
  return {
    people: lacking.filter((member) => member.userId !== null).length,
    agents: lacking.filter((member) => member.agentId !== null).length,
  };
}

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

export function readableConversationWhere(workspaceId: string, reader: { userId: string }) {
  return {
    AND: [
      {
        OR: [
          visibleChannelWhere(workspaceId, reader),
          { ...VISIBLE_CONVERSATION_WHERE, ...DIRECT_CONVERSATION_WHERE },
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

export function readablePersonConversationSql(alias: string, workspaceId: string, userId: string) {
  const conversation = Prisma.raw(alias);
  return Prisma.sql`(${readableChannelSql(alias, workspaceId, { userId })}
    OR ${conversation}."directKey" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "conversation_members" v
    WHERE v."conversationId" = ${conversation}."id" AND v."userId" = ${userId}::uuid
      AND v."leftAt" IS NULL))`;
}

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
