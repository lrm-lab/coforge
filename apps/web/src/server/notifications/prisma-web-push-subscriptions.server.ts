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
  DeferredNotification,
  DeliveryOutcome,
  MessageRecipient,
  MessageWebPushNotification,
  RecipientNotification,
  StoredWebPushSubscription,
  WebPushSubscriptionInput,
  WebPushSubscriptionStore,
} from "./web-push-notifications.server";
import { previewNotification, suppression } from "./notification-rules.server";
import {
  NotificationSettingsStore,
  type PersonNotificationSettings,
} from "./notification-settings.server";

const SUBSCRIPTION_SELECT = {
  id: true,
  endpoint: true,
  p256dh: true,
  auth: true,
  deviceKind: true,
} as const;

/** One recipient row, with the settings their notifications are decided by. */
function recipientOf(
  row: {
    userId: string | null;
    user: {
      preferences: { language: string | null } | null;
      webPushSubscriptions: StoredWebPushSubscription[];
    } | null;
  },
  settings: PersonNotificationSettings | undefined,
): MessageRecipient {
  return {
    userId: row.userId!,
    language: row.user?.preferences?.language ?? null,
    ...(settings && { settings: settings.settings, timeZone: settings.timeZone }),
    subscriptions: row.user?.webPushSubscriptions ?? [],
  };
}
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
    sequence: number;
  };
  /** Who sent it, for the "sender only" preview; null for a server notice. */
  sender: string | null;
  channelName: string | null;
  /** The users the message's stored mention rows name; a mention pierces channel mute. */
  mentionedUserIds: string[];
  title: string;
  body: string;
  system?: { kind: string; params: unknown };
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
        systemMessage: { select: { kind: true, params: true } },
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
        sequence: message.sequence,
      },
      sender: message.sender ? sender : null,
      channelName,
      mentionedUserIds,
      ...(message.systemMessage
        ? { system: { kind: message.systemMessage.kind, params: message.systemMessage.params } }
        : {}),
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
      notificationLevel: { in: ["all", "relevant"] },
      OR: [
        { notificationLevel: "all" },
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
    const rows = await this.recipientRows(context);
    const settings = await new NotificationSettingsStore(this.db).readMany(
      rows.map((row) => row.userId!),
    );
    return {
      title: context.title,
      body: context.body,
      sender: context.sender,
      ...(context.system ? { system: context.system } : {}),
      url: context.url,
      workspaceId: context.message.workspaceId,
      recipients: rows.map((row) => recipientOf(row, settings.get(row.userId!))),
    };
  }

  /** The members `recipientWhere` names, with their language and subscriptions, narrowed to who may
   * read the file for a comment conversation; `userId` narrows it to that one member. */
  private async recipientRows(context: MessageContext, userId?: string) {
    const rows = await this.db.conversationMember.findMany({
      where: this.recipientWhere(context, userId),
      select: {
        userId: true,
        user: {
          select: {
            preferences: { select: { language: true } },
            webPushSubscriptions: { select: SUBSCRIPTION_SELECT },
          },
        },
      },
    });
    return context.commentSource ? this.commentSourceRecipients(context, rows) : rows;
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
    // The in-page notification follows the same settings as a push (task #467).
    const { settings, timeZone, language } = await new NotificationSettingsStore(this.db).read(
      userId,
    );
    if (suppression(settings, timeZone, new Date())) return null;
    const locale = language === "zh-CN" ? "zh-CN" : "en";
    return {
      ...previewNotification(
        {
          title: context.title,
          body: context.body,
          sender: context.system ? null : context.sender,
        },
        settings.previewMode,
        locale,
      ),
      url: context.url,
      tag: messageNotificationTag(messageId),
      conversationPath: context.conversationPath,
      ...(!settings.sound && { silent: true }),
    };
  }

  async deferredNotification(
    messageId: string,
    userId: string,
  ): Promise<DeferredNotification | null> {
    const context = await this.loadMessageContext(messageId);
    if (!context) return null;
    const [row] = await this.recipientRows(context, userId);
    if (!row) return null;
    const [{ readThroughSequence }, thread] = await Promise.all([
      this.db.conversationMember.findFirstOrThrow({
        where: { conversationId: context.message.conversationId, userId, ...ACTIVE_MEMBER_WHERE },
        select: { readThroughSequence: true },
      }),
      context.message.threadRootId
        ? this.db.threadRead.findFirst({
            where: { rootMessageId: context.message.threadRootId, member: { userId } },
            select: { readThroughSequence: true },
          })
        : null,
    ]);
    const readThrough = context.message.threadRootId
      ? (thread?.readThroughSequence ?? 0)
      : readThroughSequence;
    const settings = await new NotificationSettingsStore(this.db).read(userId);
    return {
      conversationId: context.message.conversationId,
      title: context.title,
      body: context.body,
      sender: context.sender,
      ...(context.system ? { system: context.system } : {}),
      url: context.url,
      recipient: recipientOf(row, settings),
      read: readThrough >= context.message.sequence,
    };
  }

  settingsFor(userId: string) {
    return new NotificationSettingsStore(this.db).read(userId);
  }

  /** One `UPDATE` per kind of outcome (success, or each failure reason) for a whole fan-out, not
   * one per subscription; each kind is stamped with its first outcome's time (milliseconds apart). */
  async recordDeliveries(outcomes: DeliveryOutcome[]) {
    const groups = new Map<string, { ids: string[]; outcome: DeliveryOutcome }>();
    for (const outcome of outcomes) {
      const kind = outcome.ok ? "ok" : `failed:${outcome.reason ?? "failed"}`;
      const group = groups.get(kind) ?? { ids: [], outcome };
      group.ids.push(outcome.id);
      groups.set(kind, group);
    }
    await Promise.all(
      [...groups.values()].map(({ ids, outcome }) =>
        this.db.webPushSubscription.updateMany({
          where: { id: { in: ids } },
          data: outcome.ok
            ? { lastSuccessAt: outcome.at }
            : { lastFailureAt: outcome.at, lastFailureReason: outcome.reason ?? "failed" },
        }),
      ),
    );
  }

  /** The person's browsers as Settings lists them, newest first. */
  async devicesForUser(userId: string) {
    return this.db.webPushSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        endpoint: true,
        deviceKind: true,
        deviceLabel: true,
        lastSuccessAt: true,
        lastFailureAt: true,
        lastFailureReason: true,
      },
    });
  }

  async subscriptionsForUser(userId: string) {
    return this.db.webPushSubscription.findMany({
      where: { userId },
      select: SUBSCRIPTION_SELECT,
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
