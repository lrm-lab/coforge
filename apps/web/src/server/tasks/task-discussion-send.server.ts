import type { MentionSelectorInput } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { userUploadedAttachmentWhere } from "#src/server/attachments/message-attachments.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { channelActorOf } from "#src/server/conversations/channel-actor.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import {
  channelMentionTargets,
  storeMessageBody,
} from "#src/server/conversations/message-references.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import type { Transaction } from "./task-board-ports.server";
import { discussionOf, followTask, joinDiscussion } from "./task-discussion-store.server";

/**
 * A message in a task's own conversation, written the way a channel message is: its mentions and
 * task and channel references resolved against the board and stored as tokens, its uploads linked,
 * a mention row for each person or Agent it names. The sender follows the task, and so does anyone
 * it mentions; every Agent that follows or is mentioned is delivered the message. Under the
 * board's lock, so a sender who left the board meanwhile is refused as if the task were gone.
 */
export async function postTaskMessage(
  tx: Transaction,
  input: {
    taskId: string;
    scope: { conversationId: string; workspaceId: string };
    member: { id: string; userId: string | null; agentId: string | null };
    body: string;
    /** Uploads the sender made to the task's conversation; only a person has any. */
    attachmentIds?: readonly string[];
    /** Members the sender named by id (the composer's picks), beside the `@handle`s in `body`. */
    mentions?: readonly MentionSelectorInput[];
  },
) {
  const { taskId, scope, member } = input;
  const { workspaceId } = scope;
  await lockConversation(tx, scope.conversationId);
  const [active, task] = await Promise.all([
    tx.conversationMember.findFirst({
      where: { id: member.id, conversationId: scope.conversationId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true },
    }),
    tx.task.findUnique({
      where: { id: taskId },
      select: { id: true, discussionConversationId: true },
    }),
  ]);
  if (!active || !task) throw new AppError("NOT_FOUND");
  const conversationId = await discussionOf(tx, task, workspaceId);
  await lockConversation(tx, conversationId);
  const seat = await joinDiscussion(tx, workspaceId, conversationId, member);

  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  const available = attachmentIds.length
    ? await tx.attachment.findMany({
        where: {
          id: { in: attachmentIds },
          conversationId,
          workspaceId,
          ...(member.userId
            ? userUploadedAttachmentWhere(member.userId)
            : { uploaderAgentId: member.agentId }),
          messageId: null,
        },
        select: { id: true },
      })
    : [];
  if (available.length !== attachmentIds.length) throw new AppError("ACCESS_DENIED");

  const stored = await storeMessageBody(
    tx,
    { workspaceId, conversationId: scope.conversationId, reader: channelActorOf(member) },
    input.body,
    {
      targets: (handles) => channelMentionTargets(tx, scope, handles),
      bindings: input.mentions,
    },
  );
  await followTask(tx, scope, taskId, member.id, "replied");
  // A mention row belongs to a member of the message's own conversation, so each person or Agent
  // named takes a seat in the task's conversation (as the sender did) and follows the task. The
  // seat only keeps their read position; the board is what lets them read.
  const mentionedMembers = await tx.conversationMember.findMany({
    where: { id: { in: stored.mentions.map((mention) => mention.key) } },
    select: { id: true, userId: true, agentId: true, agent: { select: { deletedAt: true } } },
  });
  const seatOf = new Map<string, string>();
  for (const named of mentionedMembers) {
    seatOf.set(named.id, (await joinDiscussion(tx, workspaceId, conversationId, named)).id);
    // A deleted Agent keeps its mention token, but follows nothing.
    if (!named.agent?.deletedAt) await followTask(tx, scope, taskId, named.id, "mentioned");
  }

  // The people who follow the task hear of it in their Activity, which lists their seat.
  const people = await tx.taskFollow.findMany({
    where: { taskId, member: { userId: { not: null }, ...ACTIVE_MEMBER_WHERE } },
    select: { member: { select: { userId: true, agentId: true } } },
  });
  for (const follower of people)
    await joinDiscussion(tx, workspaceId, conversationId, follower.member);

  const [followers, mentionedAgents] = await Promise.all([
    tx.taskFollow.findMany({
      where: {
        taskId,
        memberId: { not: member.id },
        member: { agentId: { not: null }, ...ACTIVE_MEMBER_WHERE, agent: ACTIVE_AGENT_WHERE },
      },
      select: { member: { select: { agentId: true } } },
    }),
    tx.agent.findMany({
      where: {
        id: {
          in: stored.mentions.flatMap((mention) => (mention.type === "agent" ? [mention.id] : [])),
        },
        ...ACTIVE_AGENT_WHERE,
      },
      select: { id: true },
    }),
  ]);
  const recipients = new Set([
    ...followers.map((follower) => follower.member.agentId!),
    ...mentionedAgents.map((agent) => agent.id),
  ]);
  if (member.agentId) recipients.delete(member.agentId);

  const sequence = await allocateSequence(tx, conversationId);
  const message = await tx.message.create({
    data: {
      workspaceId,
      conversationId,
      senderMemberId: seat.id,
      body: stored.body,
      sequence,
      mentions: stored.mentions.length
        ? {
            create: stored.mentions.map((mention) => ({
              memberId: seatOf.get(mention.key)!,
              workspaceId,
              kind: mention.type,
              actorId: mention.id,
              handle: mention.handle,
            })),
          }
        : undefined,
      deliveries: {
        create: [...recipients].map((agentId) => ({
          workspaceId,
          conversationId,
          agentId,
          sequence,
        })),
      },
    },
    select: { id: true, sequence: true, createdAt: true, body: true },
  });
  await Promise.all(
    attachmentIds.map((id, position) =>
      tx.attachment.update({ where: { id }, data: { messageId: message.id, position } }),
    ),
  );
  return {
    messageId: message.id,
    sequence: message.sequence,
    createdAt: message.createdAt,
    body: message.body,
  };
}
