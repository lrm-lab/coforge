import type { Prisma } from "#src/generated/prisma/client";
import { lockConversation, lockConversations } from "./conversation-lock.server";
import {
  allocateOneSequenceEach,
  allocateSequence,
} from "#src/server/db/repositories/sequence-allocation.server";
import type { ChannelActor } from "./channel-actor.server";
import { humanLabel } from "#src/lib/human-label";

export type MembershipNoticeKind =
  | "channel.member_joined"
  | "channel.member_added"
  | "channel.member_left"
  | "channel.member_removed";

type Member = {
  memberId: string | null;
  kind: "user" | "agent";
  handle: string;
  displayName: string;
};

type BaseIdentity = Omit<Member, "memberId">;

const name = (member: Member) =>
  member.kind === "agent" ? `@${member.handle}` : member.displayName;
const names = (members: readonly Member[]) => members.map(name).join(" and ");

function body(kind: MembershipNoticeKind, members: readonly Member[], actor?: Member): string {
  const who = names(members);
  switch (kind) {
    case "channel.member_joined":
      return `${who} joined this channel.`;
    case "channel.member_added":
      return `${actor ? name(actor) : "Someone"} added ${who} to this channel.`;
    case "channel.member_left":
      return `${who} left this channel.`;
    case "channel.member_removed":
      return `${actor ? name(actor) : "Someone"} removed ${who} from this channel.`;
  }
}

function isNoticeEligible(
  conversation: {
    archivedAt: Date | null;
    channelName: string | null;
    hiddenFromWorkspaceAt: Date | null;
  } | null,
): boolean {
  return !(
    conversation?.archivedAt ||
    (conversation?.channelName === "general" && conversation.hiddenFromWorkspaceAt)
  );
}

async function memberIdentity(
  tx: Prisma.TransactionClient,
  conversationId: string,
  actor: ChannelActor,
): Promise<Member> {
  if ("userId" in actor) {
    const [user, row] = await Promise.all([
      tx.user.findUnique({
        where: { id: actor.userId },
        select: { username: true, displayName: true },
      }),
      tx.conversationMember.findFirst({
        where: { conversationId, userId: actor.userId },
        select: { id: true },
      }),
    ]);
    return {
      memberId: row?.id ?? null,
      kind: "user",
      handle: user?.username ?? actor.userId,
      displayName: user ? humanLabel(user) : actor.userId,
    };
  }
  const [agent, row] = await Promise.all([
    tx.agent.findUnique({
      where: { id: actor.agentId },
      select: { name: true, displayName: true },
    }),
    tx.conversationMember.findFirst({
      where: { conversationId, agentId: actor.agentId },
      select: { id: true },
    }),
  ]);
  return {
    memberId: row?.id ?? null,
    kind: "agent",
    handle: agent?.name ?? actor.agentId,
    displayName: (agent?.displayName?.trim() || agent?.name) ?? actor.agentId,
  };
}

export type MembershipNoticeRef = { messageId: string; sequence: number };

export async function recordMembershipNotice(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    conversationId: string;
    kind: MembershipNoticeKind;
    actors: readonly ChannelActor[];
    operator?: ChannelActor;
  },
): Promise<MembershipNoticeRef | null> {
  if (input.actors.length === 0) return null;
  const conversation = await tx.conversation.findUnique({
    where: { id: input.conversationId },
    select: { archivedAt: true, channelName: true, hiddenFromWorkspaceAt: true },
  });
  if (!isNoticeEligible(conversation)) return null;
  const [members, operator] = await Promise.all([
    Promise.all(input.actors.map((actor) => memberIdentity(tx, input.conversationId, actor))),
    input.operator ? memberIdentity(tx, input.conversationId, input.operator) : undefined,
  ]);
  await lockConversation(tx, input.conversationId);
  const sequence = await allocateSequence(tx, input.conversationId);
  const message = await tx.message.create({
    data: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sequence,
      body: body(input.kind, members, operator),
    },
    select: { id: true },
  });
  const ref: MembershipNoticeRef = { messageId: message.id, sequence };
  await tx.systemMessage.create({
    data: {
      messageId: message.id,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      params: {
        members: members as unknown as Prisma.InputJsonValue,
        ...(operator ? { actor: operator as unknown as Prisma.InputJsonValue } : {}),
      } as Prisma.InputJsonObject,
    },
  });
  return ref;
}

export async function recordMembershipNotices(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    conversationIds: readonly string[];
    kind: MembershipNoticeKind;
    actors: readonly ChannelActor[];
    operator?: ChannelActor;
  },
): Promise<Array<MembershipNoticeRef & { conversationId: string }>> {
  if (input.actors.length === 0 || input.conversationIds.length === 0) return [];
  const ids = [...new Set(input.conversationIds)].sort();
  if (ids.length === 1) {
    const conversationId = ids[0]!;
    const notice = await recordMembershipNotice(tx, {
      workspaceId: input.workspaceId,
      conversationId,
      kind: input.kind,
      actors: input.actors,
      ...(input.operator ? { operator: input.operator } : {}),
    });
    return notice ? [{ ...notice, conversationId }] : [];
  }

  const conversations = await tx.conversation.findMany({
    where: { id: { in: ids } },
    select: { id: true, archivedAt: true, channelName: true, hiddenFromWorkspaceAt: true },
  });
  const eligibleSet = new Set(
    conversations.filter((conv) => isNoticeEligible(conv)).map((conv) => conv.id),
  );
  const eligibleIds = ids.filter((id) => eligibleSet.has(id));
  if (eligibleIds.length === 0) return [];

  const allActors = input.operator ? [...input.actors, input.operator] : [...input.actors];
  const userIds = [
    ...new Set(allActors.flatMap((actor) => ("userId" in actor ? [actor.userId] : []))),
  ];
  const agentIds = [
    ...new Set(allActors.flatMap((actor) => ("agentId" in actor ? [actor.agentId] : []))),
  ];
  const memberFilters: Prisma.ConversationMemberWhereInput[] = [];
  if (userIds.length > 0) memberFilters.push({ userId: { in: userIds } });
  if (agentIds.length > 0) memberFilters.push({ agentId: { in: agentIds } });

  const [users, agents, memberRows] = await Promise.all([
    userIds.length > 0
      ? tx.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, displayName: true },
        })
      : Promise.resolve([]),
    agentIds.length > 0
      ? tx.agent.findMany({
          where: { id: { in: agentIds } },
          select: { id: true, name: true, displayName: true },
        })
      : Promise.resolve([]),
    memberFilters.length > 0
      ? tx.conversationMember.findMany({
          where: { conversationId: { in: eligibleIds }, OR: memberFilters },
          select: { id: true, conversationId: true, userId: true, agentId: true },
        })
      : Promise.resolve([]),
  ]);

  const userBase = new Map<string, BaseIdentity>(
    users.map((user) => [
      user.id,
      { kind: "user", handle: user.username, displayName: humanLabel(user) },
    ]),
  );
  const agentBase = new Map<string, BaseIdentity>(
    agents.map((agent) => [
      agent.id,
      {
        kind: "agent",
        handle: agent.name,
        displayName: agent.displayName?.trim() || agent.name,
      },
    ]),
  );
  const memberIdByKey = new Map<string, string>();
  for (const row of memberRows) {
    if (row.userId) {
      const key = `${row.conversationId}:u:${row.userId}`;
      if (!memberIdByKey.has(key)) memberIdByKey.set(key, row.id);
    }
    if (row.agentId) {
      const key = `${row.conversationId}:a:${row.agentId}`;
      if (!memberIdByKey.has(key)) memberIdByKey.set(key, row.id);
    }
  }

  const resolveFor = (conversationId: string, actor: ChannelActor): Member => {
    if ("userId" in actor) {
      const base = userBase.get(actor.userId) ?? {
        kind: "user" as const,
        handle: actor.userId,
        displayName: actor.userId,
      };
      return {
        ...base,
        memberId: memberIdByKey.get(`${conversationId}:u:${actor.userId}`) ?? null,
      };
    }
    const base = agentBase.get(actor.agentId) ?? {
      kind: "agent" as const,
      handle: actor.agentId,
      displayName: actor.agentId,
    };
    return {
      ...base,
      memberId: memberIdByKey.get(`${conversationId}:a:${actor.agentId}`) ?? null,
    };
  };

  await lockConversations(tx, eligibleIds);
  const sequences = await allocateOneSequenceEach(tx, eligibleIds);

  const planned = eligibleIds.map((conversationId) => {
    const members = input.actors.map((actor) => resolveFor(conversationId, actor));
    const operator = input.operator ? resolveFor(conversationId, input.operator) : undefined;
    const sequence = sequences.get(conversationId)!;
    return {
      conversationId,
      sequence,
      members,
      operator,
      body: body(input.kind, members, operator),
    };
  });

  const created = await tx.message.createManyAndReturn({
    data: planned.map((item) => ({
      workspaceId: input.workspaceId,
      conversationId: item.conversationId,
      sequence: item.sequence,
      body: item.body,
    })),
    select: { id: true, conversationId: true, sequence: true },
  });
  const createdByConv = new Map(created.map((row) => [row.conversationId, row]));

  await tx.systemMessage.createMany({
    data: planned.map((item) => {
      const msg = createdByConv.get(item.conversationId)!;
      return {
        messageId: msg.id,
        conversationId: item.conversationId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        params: {
          members: item.members as unknown as Prisma.InputJsonValue,
          ...(item.operator ? { actor: item.operator as unknown as Prisma.InputJsonValue } : {}),
        } as Prisma.InputJsonObject,
      };
    }),
  });

  return planned.map((item) => {
    const msg = createdByConv.get(item.conversationId)!;
    return {
      conversationId: item.conversationId,
      messageId: msg.id,
      sequence: msg.sequence,
    };
  });
}
