import type { Prisma } from "#src/generated/prisma/client";
import { lockConversation } from "./conversation-lock.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
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

/** The stored English body the Agent API, CLI and search read; the web renders `params` in the
 * viewer's language. People read as their display name, Agents as their @handle. */
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

/** Resolves one member (or the operator) to its record identity: its name from the User/Agent
 * row itself — an operator is often not a channel member (an admin removing from a channel they
 * never joined, a Workspace removal, an Agent deletion) — and its channel member row only for
 * `memberId`. */
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

/** Posts the channel record of a membership change inside the caller's transaction: a server
 * identity Message plus its `channel.member_*` SystemMessage row. No deliveries, no unread —
 * callers signal the conversation afterward as they already do. `actors` are the members the
 * record is about; `operator` names who removed/added them (self-join and self-leave carry none). */
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
  // An archived channel and a #general hidden from the Workspace take no records: nothing can
  // act on them any more, so a workspace-wide leave (member removal, Agent deletion) passes
  // them by.
  const conversation = await tx.conversation.findUnique({
    where: { id: input.conversationId },
    select: { archivedAt: true, channelName: true, hiddenFromWorkspaceAt: true },
  });
  if (
    conversation?.archivedAt ||
    (conversation?.channelName === "general" && conversation.hiddenFromWorkspaceAt)
  )
    return null;
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
