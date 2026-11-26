import { deliveryTarget } from "./direct-conversation-agent-message.server";
import { assertAgentDmWithinLimits } from "#src/server/conversations/agent-dm-limits.server";
import { liveAgentPeer, peerSeatTarget } from "./agent-peer-direct.repositories.server";
import {
  resolveMessage,
  THREAD_ROOT_SCOPE,
  type DirectConversationPorts,
} from "./agent-targets.repositories.server";
import { isAgentPeerDirectKey } from "#src/features/conversations/direct-key";
import { AppError } from "#src/lib/app-error";
import { allocateSequence } from "./sequence-allocation.server";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { canDirectMessageAgent } from "#src/server/agents/agent-visibility.server";
import { agentChannelReader } from "#src/server/agents/workspace-assistant-authority.server";
import type { ChannelActor } from "#src/server/conversations/channel-actor.server";
import { channelAgentRecipients } from "#src/server/conversations/channel-agent-recipients.server";
import { enrollThreadReplyFollowers } from "#src/server/conversations/channel-threads.server";
import { attachmentInOtherConversation } from "#src/server/attachments/attachment-in-other-conversation.server";
import { AgentSendRejectedError } from "#src/server/conversations/agent-send-rejected-error.server";
import {
  channelMentionTargets,
  storeMessageBody,
  writeMessageReferences,
} from "#src/server/conversations/message-references.server";
import { recordThreadCreatedByReply } from "#src/server/app-notifications/channel-events.server";
import { joinChannelAsAgentIn } from "#src/server/conversations/agent-channel-join.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import {
  recordPendingMentionActions,
  unboundMentionTargets,
} from "#src/server/conversations/pending-mention-action-recording.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import type { AgentMentionBinding } from "./direct-conversation-types.server";

export async function sendAgentMessage(
  ports: DirectConversationPorts,
  conversationId: string,
  agentId: string,
  body: string,
  attachmentIds?: string[],
  threadRootId?: string,
  mentions?: readonly AgentMentionBinding[],
  joinChannel?: boolean,
) {
  const conversation = await ports.db.conversation.findUnique({
    where: { id: conversationId },
    select: { workspaceId: true, channelName: true, archivedAt: true, directKey: true },
  });
  if (!conversation) throw new AppError("TARGET_NOT_ACCESSIBLE");
  const agentPeer = !conversation.channelName && isAgentPeerDirectKey(conversation.directKey ?? "");
  if (conversation.channelName && conversation.archivedAt) throw new AppError("CONFLICT");
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
        agent: { select: { ...MESSAGE_SENDER_SELECT.select.agent.select, displayName: true } },
        user: MESSAGE_SENDER_SELECT.select.user,
      },
    }),
    agentPeer ? liveAgentPeer(ports.db, conversation, agentId) : undefined,
    threadRootId
      ? resolveMessage(ports, conversationId, threadRootId, THREAD_ROOT_SCOPE)
      : undefined,
  ]);
  let sender = members.find((m) => m.agentId === agentId && !m.leftAt);
  const user = members.find((m) => m.userId && !m.leftAt);
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
  const joining = joinChannel === true && !sender && conversation.channelName !== null;
  if (!sender || (!conversation.channelName && !(agentPeer ? peer : user))) {
    if (!joining) throw new AgentSendRejectedError(403, "agent is not a conversation member");
  }
  let reader: ChannelActor = { agentId };
  if (!conversation.channelName && user) {
    const self = await ports.db.agent.findUnique({
      where: { id: agentId },
      select: { ownerId: true, visibility: true, systemKind: true },
    });
    if (self && !canDirectMessageAgent(user.userId!, self))
      throw new AgentSendRejectedError(
        403,
        "this Agent is private; the direct message is read-only",
      );
    if (self?.systemKind === WORKSPACE_ASSISTANT_KIND)
      reader = await agentChannelReader(ports.db, conversation.workspaceId, agentId);
  }
  const result = await ports.db.$transaction(async (tx) => {
    if (joining) {
      const state = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { archivedAt: true },
      });
      if (state.archivedAt) throw new AppError("CONFLICT");
      await joinChannelAsAgentIn(tx, conversation.workspaceId, conversationId, agentId);
      sender = await tx.conversationMember.findFirstOrThrow({
        where: { conversationId, agentId, ...ACTIVE_MEMBER_WHERE },
        include: {
          agent: { select: { ...MESSAGE_SENDER_SELECT.select.agent.select, displayName: true } },
          user: MESSAGE_SENDER_SELECT.select.user,
        },
      });
    }
    if (!sender) throw new AgentSendRejectedError(403, "agent is not a conversation member");
    const sequence = await allocateSequence(tx, conversationId);
    if (peer)
      await assertAgentDmWithinLimits(tx, {
        conversationId,
        workspaceId: conversation.workspaceId,
        senderAgentId: agentId,
      });
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
      }
    }
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
    const missingAttachmentIds = requestedAttachmentIds.filter((id) => !attachmentsById.has(id));
    if (missingAttachmentIds.length)
      throw (
        (await attachmentInOtherConversation(tx, {
          workspaceId: conversation.workspaceId,
          conversationId,
          missingIds: missingAttachmentIds,
          uploader: { uploaderAgentId: agentId },
          agentId,
        })) ?? new AgentSendRejectedError(403, "attachment is not available for this message")
      );
    for (const attachmentId of requestedAttachmentIds)
      attachments.push(attachmentsById.get(attachmentId)!);
    const stored = await storeMessageBody(
      tx,
      { workspaceId: conversation.workspaceId, conversationId, reader },
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
    if (conversation.channelName && root)
      await enrollThreadReplyFollowers(tx, {
        workspaceId: conversation.workspaceId,
        conversationId,
        root,
        participantMemberIds: [sender.id, ...stored.mentions.map((mention) => mention.key)],
      });
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
    const created = await tx.message.create({
      data: {
        conversationId,
        workspaceId: conversation.workspaceId,
        senderMemberId: sender.id,
        threadRootId: root?.id,
        body: stored.body,
        sequence,
      },
      select: {
        id: true,
        body: true,
        createdAt: true,
        sequence: true,
        threadRootId: true,
      },
    });
    await writeMessageReferences(
      tx,
      created,
      { conversationId, workspaceId: conversation.workspaceId },
      stored.references,
    );
    if (stored.mentions.length)
      await tx.messageMention.createMany({
        data: stored.mentions.map((mention) => ({
          messageId: created.id,
          conversationId,
          memberId: mention.key,
          workspaceId: conversation.workspaceId,
          kind: mention.type,
          actorId: mention.id,
          handle: mention.handle,
        })),
      });
    const deliveryIds = recipients.map(() => Bun.randomUUIDv7());
    const deliveries = recipients.length
      ? await tx.$queryRaw<{ deliveryId: string; agentId: string; computerId: string | null }[]>`
          WITH inserted AS (
            INSERT INTO "agent_message_deliveries"
              ("deliveryId", "messageId", "workspaceId", "conversationId", "agentId", "sequence")
            SELECT delivery."deliveryId", ${created.id}::uuid, ${conversation.workspaceId}::uuid,
              ${conversationId}::uuid, delivery."agentId", ${sequence}
            FROM unnest(${deliveryIds}::uuid[], ${recipients}::uuid[]) WITH ORDINALITY
              AS delivery("deliveryId", "agentId", position)
            ORDER BY delivery.position
            RETURNING "deliveryId", "agentId"
          )
          SELECT inserted."deliveryId"::text AS "deliveryId", inserted."agentId"::text AS "agentId",
            agent."computerId"::text AS "computerId"
          FROM inserted
          JOIN "agents" agent ON agent."id" = inserted."agentId"
          ORDER BY array_position(${recipients}::uuid[], inserted."agentId")`
      : [];
    if (conversation.channelName) {
      await recordPendingMentionActions(
        tx,
        {
          id: created.id,
          workspaceId: conversation.workspaceId,
          conversationId,
          senderMemberId: sender.id,
          body: stored.body,
          createdAt: created.createdAt,
        },
        unboundMentionTargets(mentions ?? [], stored.mentions),
      );
      if (root)
        await recordThreadCreatedByReply(tx, {
          workspaceId: conversation.workspaceId,
          channelId: conversationId,
          threadRootId: root.id,
          messageId: created.id,
        });
    }
    for (const [position, attachment] of attachments.entries()) {
      await tx.attachment.update({
        where: { id: attachment.id },
        data: { messageId: created.id, position },
      });
    }
    return {
      ...created,
      mentions: stored.mentions.map((mention) => ({
        kind: mention.type,
        actorId: mention.id,
        handle: mention.handle,
      })),
      deliveries,
      attachments,
    };
  });
  const senderIdentity = agentMessageSender({ agentId, agent: sender!.agent, user: null });
  return {
    ...result,
    joinedChannel: joining ? `#${conversation.channelName}` : undefined,
    deliveryId: undefined,
    workspaceId: conversation.workspaceId,
    agentId,
    channelName: conversation.channelName,
    senderDisplayName: sender!.agent?.displayName ?? null,
    latestSenderKind: senderIdentity.kind,
    latestSenderHandle: senderIdentity.handle,
    latestSenderDescription: senderIdentity.description,
    deliveries: result.deliveries.map((delivery) => ({
      deliveryId: delivery.deliveryId,
      agentId: delivery.agentId,
      computerId: delivery.computerId,
    })),
    target: conversation.channelName
      ? deliveryTarget(`#${conversation.channelName}`, root?.id)
      : peer
        ? deliveryTarget(await peerSeatTarget(ports.db, conversation, members, peer.id), root?.id)
        : "",
    attachments: result.attachments,
  };
}
