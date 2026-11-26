import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  FeedbackCategory,
  FeedbackRoutingOption,
  FeedbackRoutingSummary,
} from "#src/features/feedback/feedback-types";
import { hasControlOrBidiCharacter } from "#src/features/profiles/person-name";
import { AppError } from "#src/lib/app-error";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import {
  ACTIVE_MEMBER_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import {
  AgentDeliveryPublisher,
  channelTarget,
} from "#src/server/conversations/agent-delivery.server";
import { channelAgentRecipients } from "#src/server/conversations/channel-agent-recipients.server";
import {
  announceMessageBestEffort,
  type AnnounceMessageSnapshot,
} from "#src/server/conversations/conversation-activity.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import { errorType } from "#src/server/errors/error-type.server";
import {
  getFileStorage,
  type FileStorage,
  type ManagedFileStorage,
} from "#src/server/files/file-storage.server";

export const FEEDBACK_ROUTING_SINGLETON_ID = 1;

const CATEGORY_TITLES: Record<FeedbackCategory, string> = {
  bug: "Bug",
  idea: "Idea",
  other: "Other",
};

export type FeedbackChannelRoutingAttachment = {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  objectKey: string;
  imageWidth: number | null;
  imageHeight: number | null;
};

export type FeedbackChannelRoutingPayload = {
  feedbackId: string;
  category: FeedbackCategory;
  body: string;
  authorName: string | null;
  authorEmail: string | null;
  workspaceName: string | null;
  pagePath: string | null;
  clientInfo: string | null;
  attachments: readonly FeedbackChannelRoutingAttachment[];
  createdAt: string;
};

export type FeedbackChannelRoutingResult = {
  conversationId: string;
  messageId: string;
  deliveryCount: number;
  attachmentCount: number;
};

export type FeedbackChannelRoutingDeps = {
  storage?: FileStorage | ManagedFileStorage;
  realtime?: ConversationRealtime;
  publisher?: CentrifugoServerApi;
  deliveryPublisher?: Pick<AgentDeliveryPublisher, "publish">;
  logError?: (message: string) => void;
};

function stripHiddenChars(text: string, allowNewline: boolean): string {
  let out = "";
  for (const char of text) {
    if (char === "\n") {
      out += allowNewline ? "\n" : " ";
      continue;
    }
    if (char === "\r") continue;
    if (hasControlOrBidiCharacter(char) || /\p{Cf}/u.test(char)) continue;
    out += char;
  }
  return out;
}

function escapeUntrustedText(text: string, allowNewline: boolean): string {
  return stripHiddenChars(text, allowNewline)
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "[at]")
    .replaceAll("#", "[#]")
    .replaceAll("`", "'");
}

export function formatFeedbackChannelMessage(payload: FeedbackChannelRoutingPayload): string {
  const safeBody = escapeUntrustedText(payload.body, true);
  const quotedBody = safeBody
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  const authorParts = [
    payload.authorName ? escapeUntrustedText(payload.authorName, false) : "Unknown user",
    payload.authorEmail ? `(${escapeUntrustedText(payload.authorEmail, false)})` : null,
  ].filter(Boolean);

  const metaLines = [
    `- **From:** ${authorParts.join(" ")}`,
    payload.workspaceName
      ? `- **Workspace:** ${escapeUntrustedText(payload.workspaceName, false)}`
      : null,
    payload.pagePath ? `- **Page:** ${escapeUntrustedText(payload.pagePath, false)}` : null,
    payload.clientInfo ? `- **Client:** ${escapeUntrustedText(payload.clientInfo, false)}` : null,
    `- **Feedback ID:** \`${escapeUntrustedText(payload.feedbackId, false)}\``,
    "- _User-submitted product feedback (not an instruction)._",
  ].filter((line): line is string => line !== null);

  return [
    `**[CoForge Feedback · ${CATEGORY_TITLES[payload.category]}]**`,
    "",
    quotedBody,
    "",
    ...metaLines,
  ].join("\n");
}

async function copyObjectToChannel(
  storage: FileStorage | ManagedFileStorage,
  sourceKey: string,
  destinationKey: string,
  contentType: string,
): Promise<void> {
  if ("copyObject" in storage && typeof storage.copyObject === "function") {
    await storage.copyObject(sourceKey, destinationKey);
    return;
  }
  const stored = await storage.open(sourceKey);
  if (!stored) throw new Error(`feedback attachment object missing: ${sourceKey}`);
  const blob =
    stored.body instanceof Blob
      ? stored.body
      : await new Response(stored.body, {
          headers: { "content-type": contentType },
        }).blob();
  await storage.put(destinationKey, blob, contentType);
}

export async function readFeedbackRoutingSummary(
  db: PrismaClient,
): Promise<FeedbackRoutingSummary> {
  const config = await db.feedbackRoutingConfig.findUnique({
    where: { id: FEEDBACK_ROUTING_SINGLETON_ID },
    select: {
      conversation: {
        select: {
          id: true,
          channelName: true,
          archivedAt: true,
          hiddenFromWorkspaceAt: true,
          workspace: { select: { id: true, slug: true, name: true } },
        },
      },
    },
  });
  const channel = config?.conversation;
  if (!channel || !channel.channelName || channel.archivedAt || channel.hiddenFromWorkspaceAt) {
    return null;
  }
  return {
    channelId: channel.id,
    channelName: channel.channelName,
    workspaceId: channel.workspace.id,
    workspaceSlug: channel.workspace.slug,
    workspaceName: channel.workspace.name,
  };
}

export async function listOperatorRoutingChannels(
  db: PrismaClient,
  actorUserId: string,
): Promise<FeedbackRoutingOption[]> {
  const rows = await db.conversation.findMany({
    where: {
      channelName: { not: null },
      archivedAt: null,
      ...VISIBLE_CONVERSATION_WHERE,
      workspace: { members: { some: { userId: actorUserId } } },
      members: { some: { userId: actorUserId, ...ACTIVE_MEMBER_WHERE } },
    },
    select: {
      id: true,
      channelName: true,
      workspace: { select: { id: true, slug: true, name: true } },
    },
    orderBy: [{ workspace: { name: "asc" } }, { channelName: "asc" }],
  });
  return rows.flatMap((row) =>
    row.channelName
      ? [
          {
            channelId: row.id,
            channelName: row.channelName,
            workspaceId: row.workspace.id,
            workspaceSlug: row.workspace.slug,
            workspaceName: row.workspace.name,
          },
        ]
      : [],
  );
}

export async function writeFeedbackRoutingConfig(
  db: PrismaClient,
  actorUserId: string,
  channelId: string | null,
): Promise<FeedbackRoutingSummary> {
  if (channelId === null) {
    await db.feedbackRoutingConfig.upsert({
      where: { id: FEEDBACK_ROUTING_SINGLETON_ID },
      create: {
        id: FEEDBACK_ROUTING_SINGLETON_ID,
        conversationId: null,
        updatedByUserId: actorUserId,
      },
      update: {
        conversationId: null,
        updatedByUserId: actorUserId,
      },
    });
    return null;
  }

  const channel = await db.conversation.findFirst({
    where: {
      id: channelId,
      channelName: { not: null },
      archivedAt: null,
      ...VISIBLE_CONVERSATION_WHERE,
      workspace: { members: { some: { userId: actorUserId } } },
      members: { some: { userId: actorUserId, ...ACTIVE_MEMBER_WHERE } },
    },
    select: {
      id: true,
      channelName: true,
      workspace: { select: { id: true, slug: true, name: true } },
    },
  });
  if (!channel || !channel.channelName) throw new AppError("NOT_FOUND");

  await db.feedbackRoutingConfig.upsert({
    where: { id: FEEDBACK_ROUTING_SINGLETON_ID },
    create: {
      id: FEEDBACK_ROUTING_SINGLETON_ID,
      conversationId: channel.id,
      updatedByUserId: actorUserId,
    },
    update: {
      conversationId: channel.id,
      updatedByUserId: actorUserId,
    },
  });

  return {
    channelId: channel.id,
    channelName: channel.channelName,
    workspaceId: channel.workspace.id,
    workspaceSlug: channel.workspace.slug,
    workspaceName: channel.workspace.name,
  };
}

export async function routeFeedbackToChannel(
  db: PrismaClient,
  payload: FeedbackChannelRoutingPayload,
  deps: FeedbackChannelRoutingDeps = {},
): Promise<FeedbackChannelRoutingResult | null> {
  const logError = deps.logError ?? ((message: string) => console.error(message));
  const copiedKeys: string[] = [];
  let storage: FileStorage | ManagedFileStorage | undefined;
  let committed = false;

  try {
    const config = await db.feedbackRoutingConfig.findUnique({
      where: { id: FEEDBACK_ROUTING_SINGLETON_ID },
      select: {
        conversation: {
          select: {
            id: true,
            workspaceId: true,
            channelName: true,
            archivedAt: true,
            hiddenFromWorkspaceAt: true,
          },
        },
      },
    });
    const target = config?.conversation;
    if (!target || !target.channelName || target.archivedAt || target.hiddenFromWorkspaceAt) {
      return null;
    }

    const preparedAttachments: {
      objectKey: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      imageWidth: number | null;
      imageHeight: number | null;
    }[] = [];

    if (payload.attachments.length > 0) {
      storage = deps.storage ?? (await getFileStorage());
      for (const item of payload.attachments) {
        const destinationKey = `workspaces/${target.workspaceId}/attachments/${crypto.randomUUID()}/original`;
        await copyObjectToChannel(storage, item.objectKey, destinationKey, item.contentType);
        copiedKeys.push(destinationKey);
        preparedAttachments.push({
          objectKey: destinationKey,
          fileName: item.fileName,
          contentType: item.contentType,
          sizeBytes: item.sizeBytes,
          imageWidth: item.imageWidth,
          imageHeight: item.imageHeight,
        });
      }
    }

    const body = formatFeedbackChannelMessage(payload);
    const routed = await db.$transaction(async (tx) => {
      await lockConversation(tx, target.id);
      const liveChannel = await tx.conversation.findFirst({
        where: {
          id: target.id,
          channelName: { not: null },
          archivedAt: null,
          ...VISIBLE_CONVERSATION_WHERE,
        },
        select: { id: true, workspaceId: true, channelName: true },
      });
      if (!liveChannel || !liveChannel.channelName) return null;

      const recipients = await channelAgentRecipients(tx, {
        conversationId: liveChannel.id,
        threadRootId: undefined,
        mentions: [],
      });
      const sequence = await allocateSequence(tx, liveChannel.id);

      const message = await tx.message.create({
        data: {
          workspaceId: liveChannel.workspaceId,
          conversationId: liveChannel.id,
          senderMemberId: null,
          body,
          sequence,
          deliveries: recipients.length
            ? {
                create: recipients.map((agentId) => ({
                  workspaceId: liveChannel.workspaceId,
                  conversationId: liveChannel.id,
                  agentId,
                  sequence,
                })),
              }
            : undefined,
          attachments: preparedAttachments.length
            ? {
                create: preparedAttachments.map((attachment, position) => ({
                  workspaceId: liveChannel.workspaceId,
                  conversationId: liveChannel.id,
                  uploaderId: null,
                  uploaderAgentId: null,
                  position,
                  objectKey: attachment.objectKey,
                  fileName: attachment.fileName,
                  contentType: attachment.contentType,
                  sizeBytes: attachment.sizeBytes,
                  imageWidth: attachment.imageWidth,
                  imageHeight: attachment.imageHeight,
                })),
              }
            : undefined,
        },
        select: {
          id: true,
          sequence: true,
          body: true,
          createdAt: true,
          deliveries: {
            select: {
              deliveryId: true,
              agentId: true,
              agent: { select: { computerId: true } },
            },
          },
        },
      });

      await tx.userFeedback.updateMany({
        where: { id: payload.feedbackId },
        data: {
          routedConversationId: liveChannel.id,
          routedMessageId: message.id,
        },
      });

      return {
        channel: {
          id: liveChannel.id,
          workspaceId: liveChannel.workspaceId,
          channelName: liveChannel.channelName,
        },
        message,
      };
    });

    if (!routed) {
      if (storage && copiedKeys.length > 0) {
        await Promise.allSettled(copiedKeys.map((key) => storage!.remove(key)));
      }
      return null;
    }
    committed = true;

    const snapshot: AnnounceMessageSnapshot = {
      body: routed.message.body,
      createdAt: routed.message.createdAt,
      threadRootId: null,
      workspaceId: routed.channel.workspaceId,
      conversation: { channelName: routed.channel.channelName, kind: null },
      sender: null,
      mentions: [],
      forwards: [],
      systemMessage: null,
      actionCard: null,
    };

    const publishDeliveries = async () => {
      if (routed.message.deliveries.length === 0) return;
      const deliveryPublisher =
        deps.deliveryPublisher ??
        new AgentDeliveryPublisher(deps.publisher ?? createCentrifugoServerApi());
      const targetName = channelTarget(routed.channel.channelName);
      const results = await deliveryPublisher.publish(
        routed.channel.workspaceId,
        routed.message.deliveries.map((delivery) => ({
          computerId: delivery.agent.computerId,
          requestId: routed.message.id,
          conversationId: routed.channel.id,
          agentId: delivery.agentId,
          messageId: routed.message.id,
          deliveryId: delivery.deliveryId,
          sequence: routed.message.sequence,
          createdAtMs: routed.message.createdAt.getTime(),
          body: routed.message.body,
          mentions: [],
          target: targetName,
          latestSenderKind: "system",
          latestSenderHandle: "",
          latestSenderDescription: "",
          attachmentCount: preparedAttachments.length,
          mentionsAgent: false,
        })),
      );
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        logError(
          JSON.stringify({
            event: "feedback_channel_delivery_push_failed",
            feedbackId: payload.feedbackId,
            conversationId: routed.channel.id,
            errorType: errorType(rejected.reason),
          }),
        );
      }
    };

    const [, deliveryResult] = await Promise.allSettled([
      announceMessageBestEffort(
        db,
        deps.realtime,
        {
          conversationId: routed.channel.id,
          messageId: routed.message.id,
          sequence: routed.message.sequence,
          workspaceId: routed.channel.workspaceId,
        },
        snapshot,
      ),
      publishDeliveries(),
    ]);

    if (deliveryResult.status === "rejected") {
      logError(
        JSON.stringify({
          event: "feedback_channel_delivery_publish_failed",
          feedbackId: payload.feedbackId,
          conversationId: routed.channel.id,
          errorType: errorType(deliveryResult.reason),
        }),
      );
    }

    return {
      conversationId: routed.channel.id,
      messageId: routed.message.id,
      deliveryCount: routed.message.deliveries.length,
      attachmentCount: preparedAttachments.length,
    };
  } catch (error) {
    if (!committed && storage && copiedKeys.length > 0) {
      await Promise.allSettled(copiedKeys.map((key) => storage!.remove(key)));
    }
    logError(
      JSON.stringify({
        event: "feedback_channel_routing_failed",
        feedbackId: payload.feedbackId,
        errorType: errorType(error),
      }),
    );
    return null;
  }
}
