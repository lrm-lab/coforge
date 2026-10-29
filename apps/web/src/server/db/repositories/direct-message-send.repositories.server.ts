import { deliveryTarget } from "./direct-conversation-agent-message.server";
import type { SentMessageHook } from "#src/server/conversations/sent-message-hook.server";
import { humanRef } from "./agent-peer-direct.repositories.server";
import { resolveMessage, type DirectConversationPorts } from "./agent-targets.repositories.server";
import { isAppBot } from "#src/features/agents/agent-system-kind";
import { AppError } from "#src/lib/app-error";
import { allocateSequence } from "./sequence-allocation.server";
import { canDirectMessageAgent } from "#src/server/agents/agent-visibility.server";
import { storeMessageBody } from "#src/server/conversations/message-references.server";
import { agentMessageSender } from "#src/server/conversations/sender-display.server";
import {
  attachmentView,
  ATTACHMENT_VIEW_SELECT,
  type AttachmentViewRow,
} from "#src/server/attachments/attachment-view.server";

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
