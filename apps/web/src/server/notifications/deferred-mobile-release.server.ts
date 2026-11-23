import type { ComputerActivityReader } from "./computer-activity.server";
import { MAX_DEFER_MS, type DeferredPushQueue } from "./deferred-mobile-pushes.server";
import { deferredPushRoute } from "./push-routes.server";
import { mobileDeferredUntil, suppression } from "./notification-rules.server";
import type {
  DeferredNotification,
  StoredWebPushSubscription,
  WebPushSubscriptionStore,
} from "./web-push-notifications.server";

/** What became of a person's waiting phone notifications when they were looked at again. */
export type DeferredOutcome = "sent" | "waiting" | "suppressed" | "gone";

/** A message to ring a person's phones with now. */
export type PhoneRelease = { messageId: string; waiting: DeferredNotification };

const DEFERRED_READ_CONCURRENCY = 16;

/**
 * A person whose phone notifications were waiting, looked at again (task #467). While they still
 * use the computer the check reads only their settings and activity, and looks again when that
 * would end. Once they stop, their phones get one unread message per conversation, not one per
 * message: the newest that @mentions them, else the newest. A pause or quiet hours drop everything
 * waiting; so does reading a message, losing it, or 12 hours of waiting. `send` rings the phones
 * and says how many took it.
 */
export async function releaseDeferred(
  input: {
    store: Pick<WebPushSubscriptionStore, "settingsFor" | "deferredNotification">;
    queue: DeferredPushQueue;
    activity?: ComputerActivityReader;
    now: Date;
    send: (releases: PhoneRelease[]) => Promise<number>;
  },
  userId: string,
): Promise<{ outcome: DeferredOutcome; sent: number }> {
  const { store, queue, activity, now } = input;
  const { settings, timeZone, language } = await store.settingsFor(userId);
  if (suppression(settings, timeZone, now)) {
    await queue.takeMessages(userId);
    return { outcome: "suppressed", sent: 0 };
  }
  // Without the computer's activity, the phone rings rather than waits forever.
  const seen = activity ? await activity.read([userId]).catch(() => new Map()) : new Map();
  const waitUntil = mobileDeferredUntil(settings.mobileDelay, seen.get(userId) ?? null, now);
  if (waitUntil) {
    await queue.reschedule(userId, waitUntil);
    return { outcome: "waiting", sent: 0 };
  }
  const fresh = (await queue.takeMessages(userId)).filter(
    (entry) => now.getTime() - entry.firstQueuedAt.getTime() <= MAX_DEFER_MS,
  );
  const newest = new Map<
    string,
    PhoneRelease & { queuedAt: Date; subscriptions: StoredWebPushSubscription[] }
  >();
  const waitingEntries: { entry: (typeof fresh)[number]; waiting: DeferredNotification | null }[] =
    [];
  for (let offset = 0; offset < fresh.length; offset += DEFERRED_READ_CONCURRENCY) {
    const window = fresh.slice(offset, offset + DEFERRED_READ_CONCURRENCY);
    waitingEntries.push(
      ...(await Promise.all(
        window.map(async (entry) => ({
          entry,
          waiting: await store.deferredNotification(entry.messageId, userId, {
            settings,
            timeZone,
            language,
          }),
        })),
      )),
    );
  }
  for (const { entry, waiting } of waitingEntries) {
    if (!waiting || waiting.read) continue;
    const routes = entry.routes && new Set(entry.routes);
    const candidates = routes
      ? waiting.recipient.subscriptions
          .filter(
            (subscription) =>
              subscription.deviceKind === "mobile" &&
              (routes.has(deferredPushRoute(subscription)) ||
                routes.has(`subscription:${subscription.id}`)),
          )
          .map((subscription) => ({
            key: `${waiting.conversationId}:${subscription.id}`,
            subscriptions: [subscription],
          }))
      : [{ key: waiting.conversationId, subscriptions: waiting.recipient.subscriptions }];
    for (const { key, subscriptions } of candidates) {
      const kept = newest.get(key);
      const wins =
        !kept ||
        (waiting.mentioned && !kept.waiting.mentioned) ||
        (waiting.mentioned === kept.waiting.mentioned && entry.firstQueuedAt > kept.queuedAt);
      if (wins)
        newest.set(key, {
          messageId: entry.messageId,
          queuedAt: entry.firstQueuedAt,
          waiting,
          subscriptions,
        });
    }
  }
  const releases = new Map<string, PhoneRelease>();
  for (const { messageId, waiting, subscriptions } of newest.values()) {
    const release = releases.get(messageId);
    if (release) release.waiting.recipient.subscriptions.push(...subscriptions);
    else
      releases.set(messageId, {
        messageId,
        waiting: {
          ...waiting,
          recipient: { ...waiting.recipient, subscriptions: [...subscriptions] },
        },
      });
  }
  return { outcome: "sent", sent: await input.send([...releases.values()]) };
}
