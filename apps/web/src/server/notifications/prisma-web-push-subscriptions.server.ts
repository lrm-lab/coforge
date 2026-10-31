import type { PrismaClient } from "#src/generated/prisma/client";
import {
  BROWSER_MESSAGE_MENTIONS_SELECT,
  browserMessageMention,
} from "#src/server/conversations/mentions.server";
import {
  forwardPreviewText,
  peopleReadableBody,
} from "#src/server/conversations/message-preview-line.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import {
  keyOf,
  readAccess,
  readersAmong,
} from "#src/server/db/repositories/attachment-comment-recipients.repositories.server";
import { messageNotificationTag } from "./web-push-notifications.server";
import type {
  MessageWebPushNotification,
  RecipientNotification,
  WebPushSubscriptionInput,
  WebPushSubscriptionStore,
} from "./web-push-notifications.server";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import { humanLabel } from "#src/lib/human-label";
import { SYSTEM_SENDER_LABEL } from "#src/features/profiles/person-name";

const MESSAGE_PREVIEW_LENGTH = 180;

/** Who a notification says the message is from: a person by the name teammates know them by, an
 * Agent by its `@handle` (the handle is how it is mentioned). */
function senderLabel(
  sender: {
    agent: { name: string } | null;
    user: { username: string; displayName: string | null } | null;
  } | null,
) {
  if (!sender) return SYSTEM_SENDER_LABEL;
  if (sender.agent) return `@${sender.agent.name}`;
  if (sender.user) return humanLabel(sender.user);
  return "@unknown";
}

type MessageContext = {
  message: {
    id: string;
    conversationId: string;
    workspaceId: string;
    senderMemberId: string | null;
    threadRootId: string | null;
  };
  channelName: string | null;
  /** The users the message's stored mention rows name; a mention pierces channel mute. */
  mentionedUserIds: string[];
  title: string;
  body: string;
  url: string;
  /** The un-anchored target: what `notificationForRecipient` hands the browser to compare against
   * the conversation it may already be looking at. */
  conversationPath: string;
  /** Present only for a comment conversation's messages: who may read the file decides who gets
   * this message's notification, never the seat its sender or recipients kept in the comment
   * conversation. */
  commentSource?: {
    attachmentId: string;
    conversation: {
      id: string;
      channelName: string | null;
      visibility: string;
      archivedAt: Date | null;
      hiddenFromWorkspaceAt: Date | null;
      directKey: string | null;
    };
  };
};

export class PrismaWebPushSubscriptionStore implements WebPushSubscriptionStore {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Everything about a message that does not depend on which recipient is asking: its title/body/
   * url/conversationPath, and the ingredients (`channelName`, `mentionedUserIds`) the shared
   * recipient-eligibility where-clause needs. `notificationForMessage` and `notificationForRecipient`
   * both build on this single read so the recipient rule itself lives in exactly one place
   * (`recipientWhere`).
   */
  private async loadMessageContext(messageId: string): Promise<MessageContext | null> {
    const message = await this.db.message.findUnique({
      where: { id: messageId },
      include: {
        sender: {
          select: {
            agent: { select: { name: true } },
            user: { select: { username: true, displayName: true } },
          },
        },
        mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
        forward: { select: { sourceBody: true } },
        attachmentComment: { select: { attachmentId: true } },
        conversation: {
          include: { workspace: { select: { slug: true } } },
        },
      },
    });
    // A task's own conversation notifies no one this way (its messages tell followers through
    // Activity), and its seats are not who may read it: its board decides (`taskDiscussionAccess`).
    // A seat kept after its channel became private must not read a message by id here (task #302).
    if (!message || message.conversation.kind === "task_thread") return null;
    // A comment conversation's messages decide through the file's read access, not the seat a
    // commenter kept after leaving its channel or after it turned private.
    let commentSource: MessageContext["commentSource"];
    if (message.conversation.kind === "attachment_comments") {
      if (!message.attachmentComment) return null;
      const attachment = await this.db.attachment.findUnique({
        where: { id: message.attachmentComment.attachmentId },
        select: {
          conversation: {
            select: {
              id: true,
              channelName: true,
              visibility: true,
              archivedAt: true,
              hiddenFromWorkspaceAt: true,
              directKey: true,
            },
          },
        },
      });
      if (!attachment) return null;
      commentSource = {
        attachmentId: message.attachmentComment.attachmentId,
        conversation: attachment.conversation,
      };
    }
    const channelName = message.conversation.channelName;
    // Stored bodies carry mentions as embedded-UUID tokens; the preview reads a person's back as
    // their name, never their username, and an Agent's as its `@handle`. Mention-pierce reads the
    // stored mention rows themselves, the same rows the renderer chips, so an `@handle` in code or
    // a link label pierces nothing.
    // A forward sent without a note previews as what it forwards.
    const readableBody = forwardPreviewText(
      peopleReadableBody(message.body, message.mentions.map(browserMessageMention)),
      message.forward?.sourceBody,
    );
    const mentionedUserIds = message.mentions
      .filter((mention) => mention.kind === "user")
      .map((mention) => mention.actorId);
    const sender = senderLabel(message.sender);
    const preview =
      readableBody.length > MESSAGE_PREVIEW_LENGTH
        ? `${readableBody.slice(0, MESSAGE_PREVIEW_LENGTH - 1)}…`
        : readableBody;
    const workspaceSlug = message.conversation.workspace.slug;
    const conversationPath = workspacePath(
      workspaceSlug,
      `/${channelName ? "channel" : "dm"}/${message.conversationId}`,
    );
    // The message lives in the Chat tab; the server rendering the target never sees the hash.
    const anchoredTarget = `${conversationPath}?view=chat#message-${message.id}`;
    const url = `/notifications/open?workspace=${encodeURIComponent(workspaceSlug)}&target=${encodeURIComponent(anchoredTarget)}`;
    return {
      message: {
        id: message.id,
        conversationId: message.conversationId,
        workspaceId: message.workspaceId,
        senderMemberId: message.senderMemberId,
        threadRootId: message.threadRootId,
      },
      channelName,
      mentionedUserIds,
      title: channelName ? `#${channelName}` : sender,
      body: channelName ? `${sender}: ${preview}` : preview,
      url,
      conversationPath,
      commentSource,
    };
  }

  /**
   * The one recipient-eligibility rule (not sender, active member, `userId` not null, not muted OR
   * @mentioned OR thread-following, in a channel or a DM alike, `browserNotificationsEnabled:
   * true`), shared by every read. Passing `userId` narrows it to that one member, for `notificationForRecipient`.
   */
  private recipientWhere(context: MessageContext, userId?: string) {
    const { message, mentionedUserIds } = context;
    return {
      conversationId: message.conversationId,
      ...(message.senderMemberId ? { id: { not: message.senderMemberId } } : {}),
      userId: userId ?? { not: null },
      ...ACTIVE_MEMBER_WHERE,
      OR: [
        { channelMuted: false },
        { userId: { in: mentionedUserIds } },
        ...(message.threadRootId
          ? [{ threadFollows: { some: { rootMessageId: message.threadRootId } } }]
          : []),
      ],
      user: { preferences: { browserNotificationsEnabled: true } },
    };
  }

  /** Who among a comment conversation's seat recipients may still read the file — the same
   * `readAccess` check the by-id read applies, batched over every candidate. */
  private async commentSourceRecipients<T extends { userId: string | null }>(
    context: MessageContext,
    rows: T[],
  ): Promise<T[]> {
    const readers = await readersAmong(
      this.db,
      rows.flatMap((row) =>
        row.userId ? [{ workspaceId: context.message.workspaceId, userId: row.userId }] : [],
      ),
      context.commentSource!.attachmentId,
    );
    return rows.filter((row) => row.userId && readers.has(keyOf("user", row.userId)));
  }

  async notificationForMessage(messageId: string): Promise<MessageWebPushNotification | null> {
    const context = await this.loadMessageContext(messageId);
    if (!context) return null;
    let rows = await this.db.conversationMember.findMany({
      where: this.recipientWhere(context),
      select: {
        userId: true,
        user: {
          select: {
            webPushSubscriptions: {
              select: { id: true, endpoint: true, p256dh: true, auth: true },
            },
          },
        },
      },
    });
    if (context.commentSource) rows = await this.commentSourceRecipients(context, rows);
    return {
      title: context.title,
      body: context.body,
      url: context.url,
      workspaceId: context.message.workspaceId,
      recipients: rows.map((row) => ({
        userId: row.userId!,
        subscriptions: row.user?.webPushSubscriptions ?? [],
      })),
    };
  }

  async notificationForRecipient(
    messageId: string,
    userId: string,
  ): Promise<RecipientNotification | null> {
    const context = await this.loadMessageContext(messageId);
    if (!context) return null;
    const recipient = await this.db.conversationMember.findFirst({
      where: this.recipientWhere(context, userId),
      select: { id: true },
    });
    if (!recipient) return null;
    if (context.commentSource) {
      const access = await readAccess(
        this.db,
        { workspaceId: context.message.workspaceId, userId },
        context.commentSource.attachmentId,
      );
      if (!access?.canRead || access.conversationId !== context.message.conversationId) return null;
    }
    return {
      title: context.title,
      body: context.body,
      url: context.url,
      tag: messageNotificationTag(messageId),
      conversationPath: context.conversationPath,
    };
  }

  async subscriptionsForUser(userId: string) {
    return this.db.webPushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  }

  async saveSubscription(userId: string, subscription: WebPushSubscriptionInput) {
    await this.db.webPushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: { userId, ...subscription },
      update: { userId, ...subscription },
    });
  }

  async removeSubscription(userId: string, endpoint: string) {
    await this.db.webPushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  async removeSubscriptionById(id: string) {
    await this.db.webPushSubscription.deleteMany({ where: { id } });
  }
}
