import { deliveryTarget } from "./direct-conversation-agent-message.server";
import type { SentMessageHook } from "#src/server/conversations/sent-message-hook.server";
import { assertAgentDmWithinLimits } from "#src/server/conversations/agent-dm-limits.server";
import { humanRef, liveAgentPeer, peerSeatTarget } from "./agent-peer-direct.repositories.server";
import { resolveMessage, type DirectConversationPorts } from "./agent-targets.repositories.server";
import { isAppBot } from "#src/features/agents/agent-system-kind";
import { isAgentPeerDirectKey } from "#src/features/conversations/direct-key";
import { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { allocateSequence } from "./sequence-allocation.server";
import { canDirectMessageAgent } from "#src/server/agents/agent-visibility.server";
import { channelAgentRecipients } from "#src/server/conversations/channel-agent-recipients.server";
import { enrollThreadReplyFollowers } from "#src/server/conversations/channel-threads.server";
import { AgentSendRejectedError } from "#src/server/conversations/agent-send-rejected-error.server";
import {
  channelMentionTargets,
  storeMessageBody,
} from "#src/server/conversations/message-references.server";
import { recordThreadCreatedByReply } from "#src/server/app-notifications/channel-events.server";
import { recordPendingMentionActions } from "#src/server/conversations/pending-mention-actions.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import {
  attachmentView,
  ATTACHMENT_VIEW_SELECT,
  type AttachmentViewRow,
} from "#src/server/attachments/attachment-view.server";
import type { AgentMentionBinding } from "./direct-conversation-types.server";

export async function sendMessage(
  ports: DirectConversationPorts,
  conversationId: string,
  senderMemberId: string,
  senderUserId: string,
  body: string,
  attachmentIds?: string[],
  threadRootId?: string,
  withinSend?: SentMessageHook,
) {
  // The thread-root read needs only the conversation id, so it runs beside the member load.
  const [conversation, root] = await Promise.all([
    ports.db.conversation.findUnique({
      where: { id: conversationId },
      select: {
        workspaceId: true,
        members: {
          select: {
            id: true,
            userId: true,
            agentId: true,
            user: { select: { username: true, description: true } },
            agent: {
              select: {
                name: true,
                computerId: true,
                ownerId: true,
                visibility: true,
                systemKind: true,
              },
            },
          },
        },
      },
    }),
    threadRootId ? resolveMessage(ports, conversationId, threadRootId, true) : undefined,
  ]);
  if (!conversation) throw new Error("conversation not found");
  const sender = conversation.members.find(
    (member) => member.id === senderMemberId && member.userId === senderUserId,
  );
  const agents = conversation.members.filter((member) => member.agentId !== null);
  if (!sender) throw new Error("sender is not a conversation member");
  if (conversation.members.length !== 2 || agents.length !== 1 || !agents[0]?.agentId)
    throw new Error("only User-Agent direct conversations are supported");
  // A private Agent's direct conversation stays scoped to its own creator: once it
  // goes private, an existing DM held by anyone else stops accepting new messages, though its
  // history stays readable.
  if (agents[0].agent && !canDirectMessageAgent(senderUserId, agents[0].agent))
    throw new AppError("AGENT_DM_RESTRICTED");
  const message = await ports.db.$transaction(async (tx) => {
    const sequence = await allocateSequence(tx, conversationId);
    // Validated before the message exists, then linked (messageId + position) once it does; see
    // the multi-attachment transaction pattern shared by every send path in this file.
    const requestedAttachmentIds = attachmentIds ?? [];
    const availableAttachments = requestedAttachmentIds.length
      ? await tx.attachment.findMany({
          where: {
            id: { in: [...new Set(requestedAttachmentIds)] },
            conversationId,
            workspaceId: conversation.workspaceId,
            uploaderId: senderUserId,
            messageId: null,
          },
          select: ATTACHMENT_VIEW_SELECT,
        })
      : [];
    const attachmentsById = new Map(
      availableAttachments.map((attachment) => [attachment.id, attachment]),
    );
    const attachments: AttachmentViewRow[] = [];
    for (const attachmentId of requestedAttachmentIds) {
      const attachment = attachmentsById.get(attachmentId);
      if (!attachment) throw new Error("attachment is not available for this message");
      attachments.push(attachment);
    }
    // A DM keeps plain `@handle` text (no mention targets), but its task and channel
    // references are stored as tokens like every other conversation's.
    const stored = await storeMessageBody(
      tx,
      { workspaceId: conversation.workspaceId, conversationId },
      body,
      { targets: [] },
    );
    const created = await tx.message.create({
      data: {
        conversationId,
        workspaceId: conversation.workspaceId,
        senderMemberId,
        threadRootId: root?.id,
        body: stored.body,
        sequence,
        deliveries: {
          create: {
            workspaceId: conversation.workspaceId,
            conversationId,
            agentId: agents[0]!.agentId!,
            sequence,
          },
        },
      },
      select: {
        id: true,
        body: true,
        createdAt: true,
        sequence: true,
        // Carried so the browser signal can exclude thread replies from channel unread.
        threadRootId: true,
        deliveries: { select: { deliveryId: true } },
      },
    });
    await Promise.all(
      attachments.map((attachment, position) =>
        tx.attachment.update({
          where: { id: attachment.id },
          data: { messageId: created.id, position },
        }),
      ),
    );
    await withinSend?.(tx, {
      id: created.id,
      conversationId,
      workspaceId: conversation.workspaceId,
      body: created.body,
      senderMemberId,
      threadRootId: created.threadRootId,
    });
    return { ...created, attachments };
  });
  const senderIdentity = agentMessageSender({ agentId: null, agent: null, user: sender.user });
  const senderRef = await humanRef(
    ports.db,
    conversation.workspaceId,
    agents[0].agentId,
    senderIdentity.handle,
  );
  return {
    ...message,
    deliveryId: message.deliveries[0]!.deliveryId,
    workspaceId: conversation.workspaceId,
    agentId: agents[0].agentId,
    computerId: agents[0].agent?.computerId ?? undefined,
    appBot: isAppBot(agents[0].agent),
    target: `@${agents[0].agent?.name ?? "unknown"}`,
    latestSenderKind: senderIdentity.kind,
    latestSenderHandle: senderIdentity.handle,
    latestSenderDescription: senderIdentity.description,
    deliveryTarget: deliveryTarget(senderRef, root?.id),
    attachments: message.attachments.map((attachment) => attachmentView(attachment)),
  };
}

export async function sendAgentMessage(
  ports: DirectConversationPorts,
  conversationId: string,
  agentId: string,
  body: string,
  attachmentIds?: string[],
  threadRootId?: string,
  mentions?: readonly AgentMentionBinding[],
  memoryHintId?: string,
) {
  const conversation = await ports.db.conversation.findUnique({
    where: { id: conversationId },
    select: { workspaceId: true, channelName: true, archivedAt: true, directKey: true },
  });
  if (!conversation) throw new Error("conversation scope is not authorized");
  const agentPeer = !conversation.channelName && isAgentPeerDirectKey(conversation.directKey ?? "");
  if (conversation.channelName && conversation.archivedAt) throw new AppError("CONFLICT");
  // A DM's two members; in a channel, not the whole roster (#general holds the whole
  // Workspace) but the sending Agent's own row and the members its `--mention` bindings name.
  // The body's plain `@handle`s load their members in `storeMessageBody` below. The peer and
  // thread-root reads need only `conversation`, so all three run together.
  const [members, peer, root] = await Promise.all([
    ports.db.conversationMember.findMany({
      where: {
        conversationId,
        ...(conversation.channelName && {
          OR: [
            {
              agentId: {
                in: [
                  agentId,
                  ...(mentions ?? []).flatMap((m) => (m.type === "agent" ? [m.id] : [])),
                ],
              },
            },
            {
              userId: { in: (mentions ?? []).flatMap((m) => (m.type === "user" ? [m.id] : [])) },
            },
          ],
        }),
      },
      include: {
        agent: MESSAGE_SENDER_SELECT.select.agent,
        user: MESSAGE_SENDER_SELECT.select.user,
      },
    }),
    agentPeer ? liveAgentPeer(ports.db, conversation, agentId) : undefined,
    threadRootId ? resolveMessage(ports, conversationId, threadRootId, true) : undefined,
  ]);
  let sender = members.find((m) => m.agentId === agentId && !m.leftAt);
  const user = members.find((m) => m.userId && !m.leftAt);
  // Clear leftAt for live Agent DMs: visibility changes never leave DMs, and deleted Agents
  // have revoked keys. Preserve channel soft-leaves, which represent intentional removals.
  if (!sender && !conversation.channelName) {
    const softLeft = members.find((m) => m.agentId === agentId && m.leftAt);
    if (softLeft) {
      const self = await ports.db.agent.findUnique({
        where: { id: agentId },
        select: { deletedAt: true },
      });
      if (self && !self.deletedAt) {
        await ports.db.conversationMember.update({
          where: { id: softLeft.id },
          data: { leftAt: null },
        });
        sender = { ...softLeft, leftAt: null };
      }
    }
  }
  // Between two Agents the other is the recipient, while live.
  if (!sender || (!conversation.channelName && !(agentPeer ? peer : user)))
    throw new AgentSendRejectedError(403, "agent is not a conversation member");
  // A private Agent's own outbound DM is just as read-only as the human side of it
  // ("neither side can send"). Channels are unaffected — a private Agent is never a channel
  // member in the first place, so this only ever narrows the direct-conversation case.
  if (!conversation.channelName && user) {
    const self = await ports.db.agent.findUnique({
      where: { id: agentId },
      select: { ownerId: true, visibility: true },
    });
    if (self && !canDirectMessageAgent(user.userId!, self))
      throw new AgentSendRejectedError(
        403,
        "this Agent is private; the direct message is read-only",
      );
  }
  const messageSelect = {
    id: true,
    body: true,
    createdAt: true,
    sequence: true,
    // Carried so the browser signal can exclude thread replies from channel unread.
    threadRootId: true,
    mentions: { select: { kind: true, actorId: true, handle: true } },
    deliveries: {
      select: {
        deliveryId: true,
        agentId: true,
        agent: { select: { computerId: true } },
      },
    },
  } satisfies Prisma.MessageSelect;
  const result = await ports.db.$transaction(async (tx) => {
    let hint;
    if (memoryHintId) {
      await tx.$queryRaw`SELECT id FROM memory_hint_records
      WHERE workspace_id = ${conversation.workspaceId}::uuid AND id = ${memoryHintId}::uuid FOR UPDATE`;
      hint = await tx.memoryHintRecord.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId: conversation.workspaceId, id: memoryHintId } },
      });
      if (hint.memoryAgentId !== agentId || hint.conversationId !== conversationId)
        throw new AgentSendRejectedError(403, "Memory Hint delivery scope mismatch");
      if (hint.messageId) {
        const existing = await tx.message.findUniqueOrThrow({
          where: { id: hint.messageId },
          select: messageSelect,
        });
        return { ...existing, attachments: [] };
      }
    }
    const sequence = await allocateSequence(tx, conversationId);
    if (peer)
      await assertAgentDmWithinLimits(tx, {
        conversationId,
        workspaceId: conversation.workspaceId,
        senderAgentId: agentId,
      });
    // Require the sending Agent's own uploads before creating the message; link messageId
    // and position afterward in the same transaction.
    const requestedAttachmentIds = attachmentIds ?? [];
    const availableAttachments = requestedAttachmentIds.length
      ? await tx.attachment.findMany({
          where: {
            id: { in: [...new Set(requestedAttachmentIds)] },
            conversationId,
            workspaceId: conversation.workspaceId,
            uploaderAgentId: agentId,
            messageId: null,
          },
          select: { id: true, fileName: true, contentType: true, sizeBytes: true },
        })
      : [];
    const attachmentsById = new Map(
      availableAttachments.map((attachment) => [attachment.id, attachment]),
    );
    const attachments: {
      id: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
    }[] = [];
    for (const attachmentId of requestedAttachmentIds) {
      const attachment = attachmentsById.get(attachmentId);
      if (!attachment)
        throw new AgentSendRejectedError(403, "attachment is not available for this message");
      attachments.push(attachment);
    }
    const mentionedMemberIds: string[] = [];
    if (mentions?.length) {
      for (const mention of mentions) {
        const match = members.find((member) =>
          mention.type === "user"
            ? member.userId === mention.id && member.user?.username === mention.name
            : member.agentId === mention.id && member.agent?.name === mention.name,
        );
        if (!match)
          throw new AgentSendRejectedError(
            400,
            `mention binding does not match a conversation member: @${mention.name}`,
          );
        mentionedMemberIds.push(match.id);
      }
    }
    // Channel member mentions (structured or plain) become <@kind:uuid> plus MessageMention;
    // DM @handles stay plain. Resolved task/channel/thread references become stored tokens
    // in either conversation kind, rendered as chips without reparsing prose.
    const stored = await storeMessageBody(
      tx,
      { workspaceId: conversation.workspaceId, conversationId },
      body,
      {
        targets: conversation.channelName
          ? (handles) =>
              channelMentionTargets(
                tx,
                { workspaceId: conversation.workspaceId, conversationId },
                handles,
              )
          : [],
        bindings: mentions ?? [],
      },
    );
    // Everyone the reply mentions follows the thread: exactly the members its stored mention
    // rows name (each mention's key is the member id), plus every `--mention` binding.
    if (conversation.channelName && root)
      await enrollThreadReplyFollowers(tx, {
        workspaceId: conversation.workspaceId,
        conversationId,
        root,
        participantMemberIds: [
          sender.id,
          ...stored.mentions.map((mention) => mention.key),
          ...mentionedMemberIds,
        ],
      });
    // A person's DM wakes no Agent (its only Agent is the sender); a DM between two Agents wakes
    // the other, whatever its state.
    const recipients = conversation.channelName
      ? await channelAgentRecipients(tx, {
          conversationId,
          threadRootId: root?.id,
          mentions: stored.mentions,
          senderAgentId: agentId,
        })
      : peer
        ? [peer.id]
        : [];
    if (hint && !recipients.includes(hint.targetAgentId))
      throw new AgentSendRejectedError(403, "Memory Hint target delivery is missing");
    const created = await tx.message.create({
      data: {
        conversationId,
        workspaceId: conversation.workspaceId,
        senderMemberId: sender.id,
        threadRootId: root?.id,
        body: stored.body,
        sequence,
        mentions: stored.mentions.length
          ? {
              create: stored.mentions.map((mention) => ({
                memberId: mention.key,
                workspaceId: conversation.workspaceId,
                kind: mention.type,
                actorId: mention.id,
                handle: mention.handle,
              })),
            }
          : undefined,
        deliveries: {
          create: recipients.map((wakeAgentId) => ({
            workspaceId: conversation.workspaceId,
            conversationId,
            agentId: wakeAgentId,
            sequence,
          })),
        },
      },
      select: messageSelect,
    });
    if (hint) {
      const deliveredAt = new Date();
      await tx.memoryHintRecord.update({
        where: { id: hint.id },
        data: {
          messageId: created.id,
          deliveredAt,
          expiresAt: new Date(deliveredAt.getTime() + hint.ttlMilliseconds),
        },
      });
    }
    // A channel mention of someone outside the channel reached nobody; the sending Agent may
    // still act on it. A DM stores every `@handle` as text, so it records nothing.
    if (conversation.channelName) {
      await recordPendingMentionActions(tx, {
        id: created.id,
        workspaceId: conversation.workspaceId,
        conversationId,
        senderMemberId: sender.id,
        body: stored.body,
        createdAt: created.createdAt,
      });
      if (root)
        await recordThreadCreatedByReply(tx, {
          workspaceId: conversation.workspaceId,
          channelId: conversationId,
          threadRootId: root.id,
          messageId: created.id,
        });
    }
    await Promise.all(
      attachments.map((attachment, position) =>
        tx.attachment.update({
          where: { id: attachment.id },
          data: { messageId: created.id, position },
        }),
      ),
    );
    return { ...created, attachments };
  });
  // Never falls back to the internal Agent id: a missing name fails loudly.
  const senderIdentity = agentMessageSender({ agentId, agent: sender.agent, user: null });
  return {
    ...result,
    // Agent-originated messages must never be enqueued back to the sender.
    deliveryId: undefined,
    workspaceId: conversation.workspaceId,
    agentId,
    latestSenderKind: senderIdentity.kind,
    latestSenderHandle: senderIdentity.handle,
    latestSenderDescription: senderIdentity.description,
    deliveries: result.deliveries.map((delivery) => ({
      deliveryId: delivery.deliveryId,
      agentId: delivery.agentId,
      computerId: delivery.agent.computerId,
    })),
    target: conversation.channelName
      ? deliveryTarget(`#${conversation.channelName}`, root?.id)
      : peer
        ? deliveryTarget(await peerSeatTarget(ports.db, conversation, members, peer.id), root?.id)
        : "",
    // Agent-facing shape: metadata only; the object key never leaves the backend (never
    // selected above, unlike the browser-facing `browserMessageFields`).
    attachments: result.attachments,
  };
}
