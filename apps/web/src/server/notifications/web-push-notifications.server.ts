import { m } from "#src/paraglide/messages";
import { systemNoticeText } from "#src/features/conversations/system-notice-text";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import type { NotificationAvailableEvent } from "#src/features/conversations/conversation-realtime";
import { deferredPushRoute, pushDecision } from "./push-routes.server";
import type { ComputerActivityReader } from "./computer-activity.server";
import type { DeferredPushQueue } from "./deferred-mobile-pushes.server";
import { releaseDeferred, type DeferredOutcome } from "./deferred-mobile-release.server";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  mobileDeferredUntil,
  previewNotification,
  suppression,
  type NotificationSettings,
} from "./notification-rules.server";

export type StoredWebPushSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  browserInstallationId?: string | null;
  /** desktop | mobile as the browser reported it; absent or null is a computer, never delayed. */
  deviceKind?: string | null;
};

export type WebPushSubscriptionInput = Omit<StoredWebPushSubscription, "id"> & {
  expirationTime: Date | null;
  deviceKind?: "desktop" | "mobile" | null;
  deviceLabel?: string | null;
};

export type WebPushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  forceDisplay?: boolean;
  /** Shown without a sound: the person turned sound off (task #467). */
  silent?: boolean;
};

/** One recipient of a message: their id, and every browser subscription they currently hold (which
 * may be none — a recipient with zero subscriptions still belongs here, for the in-page path). */
export type MessageRecipient = {
  userId: string;
  /** The recipient's stored interface language, if they chose one. */
  language?: string | null;
  /** Their account notification settings, and the zone quiet hours read; absent: the defaults. */
  settings?: NotificationSettings;
  timeZone?: string;
  subscriptions: StoredWebPushSubscription[];
};

export type MessageWebPushNotification = {
  title: string;
  body: string;
  /** Who sent it, for the "sender only" preview; null for a server notice. */
  sender?: string | null;
  /** The structured notice, when the message has one; each recipient's language renders it. */
  system?: { kind: string; params: unknown };
  url: string;
  /** The message's Workspace, so the in-page publication can scope its event. */
  workspaceId: string;
  recipients: MessageRecipient[];
};

/** The `notificationForMessage` recipient rule, narrowed to one already-known recipient — the read
 * seam behind the browser's `getMessageNotification`. Never leaks whether a *different* user is a
 * recipient: a non-recipient and a non-existent message both resolve to `null`. */
export type RecipientNotification = {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** The un-anchored target (`/w/<slug>/channel/<id>` or `/w/<slug>/dm/<id>`), so the
   * browser can compare it against the page it is already looking at before showing an OS
   * notification. */
  conversationPath: string;
  /** Shown without a sound: the person turned sound off (task #467). */
  silent?: boolean;
};

/** A waiting phone notification's message as its one recipient sees it now, and whether they have
 * read it since; null when they are no longer a recipient or the message is gone. */
export type DeferredNotification = Omit<
  MessageWebPushNotification,
  "workspaceId" | "recipients"
> & {
  /** The conversation it is in: a person leaving the computer gets one per conversation. */
  conversationId: string;
  /** It @mentions this person: on release it wins over a newer plain message. */
  mentioned: boolean;
  recipient: MessageRecipient;
  read: boolean;
};

/** How one delivery to one subscription went, for its device's status. */
export type DeliveryOutcome = { id: string; ok: boolean; at: Date; reason?: string };

export interface WebPushSubscriptionStore {
  notificationForMessage(messageId: string): Promise<MessageWebPushNotification | null>;
  notificationForRecipient(
    messageId: string,
    userId: string,
  ): Promise<RecipientNotification | null>;
  deferredNotification(
    messageId: string,
    userId: string,
    notification?: { settings: NotificationSettings; timeZone: string; language?: string | null },
  ): Promise<DeferredNotification | null>;
  /** A person's settings and the zone quiet hours read, for a check that needs no message. */
  settingsFor(userId: string): Promise<{
    settings: NotificationSettings;
    timeZone: string;
    language?: string | null;
  }>;
  subscriptionsForUser(userId: string): Promise<StoredWebPushSubscription[]>;
  saveSubscription(userId: string, subscription: WebPushSubscriptionInput): Promise<void>;
  removeSubscription(userId: string, endpoint: string): Promise<void>;
  removeSubscriptionById(id: string, endpoint: string): Promise<void>;
  recordDeliveries(outcomes: DeliveryOutcome[]): Promise<void>;
}

export interface WebPushTransport {
  available?: false;
  send(subscription: StoredWebPushSubscription, payload: WebPushPayload): Promise<void>;
}

export class WebPushDeliveryError extends Error {
  constructor(
    readonly statusCode?: number,
    private readonly failedBeforeSend = false,
  ) {
    super("Web Push delivery failed");
    this.name = "WebPushDeliveryError";
  }

  get canFallback(): boolean {
    const status = this.statusCode;
    return (
      this.failedBeforeSend ||
      (status !== undefined && status >= 300 && status < 500 && status !== 408)
    );
  }
}

export class WebPushUnconfiguredError extends Error {}

export function messageNotificationTag(messageId: string): string {
  return `message:${messageId}`;
}

export type NotificationPublisher = {
  notifyRecipient(
    input: Omit<NotificationAvailableEvent, "type"> & { userId: string },
  ): Promise<void>;
};

type DeliveryResult = {
  sent: number;
  failed: number;
  removed: number;
  unreachable: number;
  errorId?: string;
};

type Locale = "en" | "zh-CN";

/** One correlated id per delivery batch, so a toast can quote what the log recorded. */
function deliveryErrorId() {
  return crypto.randomUUID();
}

/** How the Settings test reached this browser, in the words its device status uses. */
export type TestDelivery = "sent" | "removed" | "unreachable" | "failed";

/**
 * Classifies a `sendTest` result for the Settings test button: `"sent"` once any device received
 * it; otherwise the one way every attempt failed (`"removed"`, `"unreachable"` or `"failed"`, the
 * reasons a device's status records), and `"failed"` for a mix or nothing attempted.
 */
export function classifyTestDelivery(result: DeliveryResult): TestDelivery {
  if (result.sent > 0) return "sent";
  const kinds = (["removed", "unreachable", "failed"] as const).filter((kind) => result[kind] > 0);
  return kinds.length === 1 ? kinds[0] : "failed";
}

/** What a delivery needs beyond the store and transport (task #467): whether each person is at a
 * computer, where a phone's notification waits, and the clock. Without them every device is sent
 * at once. */
export type DeliveryOptions = {
  activity?: ComputerActivityReader;
  deferred?: DeferredPushQueue;
  legacyDeferred?: DeferredPushQueue;
  now?: () => Date;
};

const isPhone = (subscription: StoredWebPushSubscription) => subscription.deviceKind === "mobile";

export class WebPushNotifications {
  private readonly now: () => Date;

  constructor(
    private readonly subscriptions: WebPushSubscriptionStore,
    private readonly transport: WebPushTransport,
    private readonly publisher?: NotificationPublisher,
    private readonly options: DeliveryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  subscribe(userId: string, subscription: WebPushSubscriptionInput) {
    return this.subscriptions.saveSubscription(userId, subscription);
  }

  unsubscribe(userId: string, endpoint: string) {
    return this.subscriptions.removeSubscription(userId, endpoint);
  }

  async notifyMessage(messageId: string): Promise<DeliveryResult> {
    const notification = await this.subscriptions.notificationForMessage(messageId);
    if (!notification) return { sent: 0, failed: 0, removed: 0, unreachable: 0 };
    const now = this.now();
    const recipients = notification.recipients.filter(
      (recipient) =>
        !suppression(
          recipient.settings ?? DEFAULT_NOTIFICATION_SETTINGS,
          recipient.timeZone ?? "UTC",
          now,
        ),
    );
    const activity = await this.computerActivity(recipients);
    const outcomes: DeliveryOutcome[] = [];
    const results = await Promise.all(
      recipients.map(async (recipient) => {
        const { subscriptions, userId } = recipient;
        const phones = subscriptions.filter(isPhone);
        const settings = recipient.settings ?? DEFAULT_NOTIFICATION_SETTINGS;
        const waitUntil =
          phones.length > 0
            ? mobileDeferredUntil(settings.mobileDelay, activity.get(userId) ?? null, now)
            : null;
        const waits =
          waitUntil !== null && (await this.wait(messageId, userId, phones, now, waitUntil));
        const pushOwned = waits ? [...phones] : [];
        const result = await this.deliver(
          waits ? subscriptions.filter((subscription) => !isPhone(subscription)) : subscriptions,
          this.payloadFor(messageId, notification, recipient),
          outcomes,
          pushOwned,
        );
        await this.publishAvailable(messageId, notification.workspaceId, userId, now, pushOwned);
        return result;
      }),
    );
    await this.recordOutcomes(outcomes);
    const totals = results.reduce(
      (total, result) => ({
        sent: total.sent + result.sent,
        failed: total.failed + result.failed,
        removed: total.removed + result.removed,
        unreachable: total.unreachable + result.unreachable,
      }),
      { sent: 0, failed: 0, removed: 0, unreachable: 0 },
    );
    const errorId = results.find((result) => result.errorId)?.errorId;
    return errorId ? { ...totals, errorId } : totals;
  }

  /** A person whose phone notifications were waiting, looked at again (`releaseDeferred`). */
  async releaseDeferred(
    userId: string,
    legacy = false,
  ): Promise<{ outcome: DeferredOutcome; sent: number }> {
    const queue = legacy ? this.options.legacyDeferred : this.options.deferred;
    if (!queue) return { outcome: "gone", sent: 0 };
    return releaseDeferred(
      {
        store: this.subscriptions,
        queue,
        activity: this.options.activity,
        now: this.now(),
        send: async (releases) => {
          const outcomes: DeliveryOutcome[] = [];
          const results = await Promise.all(
            releases.map(({ messageId, waiting }) =>
              this.deliver(
                waiting.recipient.subscriptions.filter(isPhone),
                this.payloadFor(messageId, waiting, waiting.recipient),
                outcomes,
              ),
            ),
          );
          await this.recordOutcomes(outcomes);
          return results.reduce((total, result) => total + result.sent, 0);
        },
      },
      userId,
    );
  }

  private async wait(
    messageId: string,
    userId: string,
    phones: StoredWebPushSubscription[],
    now: Date,
    until: Date,
  ) {
    if (!this.options.deferred || this.transport.available === false) return false;
    try {
      await this.options.deferred.defer(
        {
          messageId,
          userId,
          firstQueuedAt: now,
          routes: phones.map(deferredPushRoute),
        },
        until,
      );
    } catch {
      console.warn(JSON.stringify({ event: "web_push.defer_unconfirmed", messageId }));
    }
    return true;
  }

  private async computerActivity(recipients: readonly MessageRecipient[]) {
    if (
      !this.options.activity ||
      !recipients.some((recipient) => recipient.subscriptions.some(isPhone))
    )
      return new Map();
    try {
      return await this.options.activity.read(recipients.map((recipient) => recipient.userId));
    } catch {
      // Without the computer's activity, a phone rings at once rather than not at all.
      return new Map();
    }
  }

  /** One recipient's payload: the notice in their language, shaped by their preview and sound. */
  private payloadFor(
    messageId: string,
    notification: Pick<MessageWebPushNotification, "title" | "body" | "sender" | "system" | "url">,
    recipient: MessageRecipient,
  ): WebPushPayload {
    const locale: Locale = recipient.language === "zh-CN" ? "zh-CN" : "en";
    const settings = recipient.settings ?? DEFAULT_NOTIFICATION_SETTINGS;
    const body = notification.system
      ? systemNoticeText({ body: notification.body, system: notification.system }, locale)
      : notification.body;
    const shown = previewNotification(
      {
        title: notification.title,
        body,
        sender: notification.system ? null : (notification.sender ?? null),
      },
      settings.previewMode,
      locale,
    );
    return {
      ...shown,
      url: notification.url,
      tag: messageNotificationTag(messageId),
      ...(!settings.sound && { silent: true }),
    };
  }

  private async publishAvailable(
    messageId: string,
    workspaceId: string,
    userId: string,
    now: Date,
    pushOwned: StoredWebPushSubscription[],
  ) {
    if (!this.publisher) return;
    try {
      await this.publisher.notifyRecipient({
        messageId,
        workspaceId,
        userId,
        at: now.getTime(),
        ...(await pushDecision(messageId, pushOwned)),
      });
    } catch {
      console.warn(JSON.stringify({ event: "in_page_notification.unavailable", messageId }));
    }
  }

  /** Opens Settings in the Workspace `workspaceSlug` names when clicked. */
  async sendTest(
    userId: string,
    endpoint: string,
    locale: Locale,
    workspaceSlug: string,
  ): Promise<DeliveryResult> {
    const subscriptions = (await this.subscriptions.subscriptionsForUser(userId)).filter(
      (subscription) => subscription.endpoint === endpoint,
    );
    return this.deliver(subscriptions, {
      title: m.preferences_browser_notifications_test_title({}, { locale }),
      body: m.preferences_browser_notifications_test_body({}, { locale }),
      url: workspacePath(workspaceSlug, "/settings"),
      tag: `test:${crypto.randomUUID()}`,
      forceDisplay: true,
    });
  }

  /** Each surviving subscription's success or failure (a removed one has no status left). */
  private outcomesOf(
    subscriptions: readonly StoredWebPushSubscription[],
    results: readonly ("sent" | "failed" | "removed" | "unreachable")[],
  ): DeliveryOutcome[] {
    const at = this.now();
    return subscriptions.flatMap((subscription, index): DeliveryOutcome[] => {
      const result = results[index];
      if (result === "removed") return [];
      return [
        {
          id: subscription.id,
          ok: result === "sent",
          at,
          ...(result !== "sent" && { reason: result }),
        },
      ];
    });
  }

  /** The devices' last outcomes, for their status in Settings, in one store call. Best-effort: a
   * failed write never fails the delivery it describes. */
  private async recordOutcomes(outcomes: DeliveryOutcome[]) {
    if (outcomes.length === 0) return;
    try {
      await this.subscriptions.recordDeliveries(outcomes);
    } catch {
      console.warn(JSON.stringify({ event: "web_push.status_unrecorded", count: outcomes.length }));
    }
  }

  /** Sends `payload` to each subscription. With `collected`, the outcomes are added to it for one
   * write by the caller instead of being written here. */
  private async deliver(
    subscriptions: StoredWebPushSubscription[],
    payload: WebPushPayload,
    collected?: DeliveryOutcome[],
    pushOwned?: StoredWebPushSubscription[],
  ): Promise<DeliveryResult> {
    const errorId = deliveryErrorId();
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await this.transport.send(subscription, payload);
          pushOwned?.push(subscription);
          return "sent" as const;
        } catch (error) {
          const deliveryError = error instanceof WebPushDeliveryError ? error : undefined;
          const statusCode = deliveryError?.statusCode;
          if (!deliveryError?.canFallback && !(error instanceof WebPushUnconfiguredError))
            pushOwned?.push(subscription);
          if (statusCode === 404 || statusCode === 410) {
            const fields = {
              errorId,
              subscriptionId: subscription.id,
              statusCode,
              outcome: "failed",
            };
            try {
              await this.subscriptions.removeSubscriptionById(
                subscription.id,
                subscription.endpoint,
              );
              console.error(JSON.stringify({ event: "web_push.subscription_removed", ...fields }));
            } catch {
              console.error(
                JSON.stringify({ event: "web_push.subscription_removal_failed", ...fields }),
              );
              return "failed" as const;
            }
            return "removed" as const;
          }
          // No status code means the transport never got a response at all (timeout, connection
          // refused, DNS failure, or an egress/encryption error it could not distinguish from one)
          // rather than the push service answering with a failure — the best signal available, not
          // a pure network classifier.
          const unreachable = error instanceof WebPushDeliveryError && statusCode === undefined;
          console.error(
            JSON.stringify({
              event: "web_push.delivery_failed",
              errorId,
              subscriptionId: subscription.id,
              statusCode,
              unreachable,
              outcome: "failed",
            }),
          );
          return unreachable ? ("unreachable" as const) : ("failed" as const);
        }
      }),
    );
    const outcomes = this.outcomesOf(subscriptions, results);
    if (collected) collected.push(...outcomes);
    else await this.recordOutcomes(outcomes);
    return {
      sent: results.filter((result) => result === "sent").length,
      failed: results.filter((result) => result === "failed").length,
      removed: results.filter((result) => result === "removed").length,
      unreachable: results.filter((result) => result === "unreachable").length,
      errorId: results.some((result) => result !== "sent") ? errorId : undefined,
    };
  }
}
