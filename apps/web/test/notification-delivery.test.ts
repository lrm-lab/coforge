import { describe, expect, test } from "bun:test";

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type ComputerActivity,
  type NotificationSettings,
} from "#src/server/notifications/notification-rules.server";
import type { DeferredPush } from "#src/server/notifications/deferred-mobile-pushes.server";
import {
  WebPushDeliveryError,
  WebPushNotifications,
  type MessageWebPushNotification,
  type StoredWebPushSubscription,
  type WebPushPayload,
  type WebPushSubscriptionStore,
} from "#src/server/notifications/web-push-notifications.server";

/**
 * How a person's notification settings shape one message's fan-out (task #467): a pause or quiet
 * hours drop them from both paths, the preview and sound shape the payload, and a phone waits while
 * the computer is in use, in a queue that asks again when the wait ends.
 */

const NOW = new Date("2026-11-03T10:00:00Z");
const MINUTE = 60_000;
const laptop = {
  id: "laptop",
  endpoint: "https://push.example/laptop",
  p256dh: "p",
  auth: "a",
  deviceKind: "desktop",
};
const phone = {
  id: "phone",
  endpoint: "https://push.example/phone",
  p256dh: "p",
  auth: "a",
  deviceKind: "mobile",
};
const oldBrowser = {
  id: "old",
  endpoint: "https://push.example/old",
  p256dh: "p",
  auth: "a",
  deviceKind: null,
};

const settings = (changes: Partial<NotificationSettings> = {}) => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  ...changes,
});

function message(
  recipients: Array<{
    userId: string;
    settings?: NotificationSettings;
    timeZone?: string;
    subscriptions: StoredWebPushSubscription[];
  }>,
): MessageWebPushNotification {
  return {
    title: "#general",
    body: "Alice: ship it",
    sender: "Alice",
    url: "/notifications/open?target=x",
    workspaceId: "workspace-a",
    recipients,
  };
}

function harness(input: {
  notification?: MessageWebPushNotification | null;
  deferred?: Awaited<ReturnType<WebPushSubscriptionStore["deferredNotification"]>>;
  activity?: Record<string, ComputerActivity>;
  now?: Date;
}) {
  const sent: Array<{ id: string; payload: WebPushPayload }> = [];
  const published: string[][] = [];
  const queued: Array<{ entry: DeferredPush; dueAt: Date }> = [];
  const recorded: Array<{ id: string; ok: boolean }> = [];
  const store: WebPushSubscriptionStore = {
    notificationForMessage: async () => input.notification ?? null,
    notificationForRecipient: async () => null,
    deferredNotification: async () => input.deferred ?? null,
    settingsFor: async () => ({ settings: DEFAULT_NOTIFICATION_SETTINGS, timeZone: "UTC" }),
    subscriptionsForUser: async () => [],
    saveSubscription: async () => {},
    removeSubscription: async () => {},
    removeSubscriptionById: async () => {},
    recordDeliveries: async (outcomes) => {
      recorded.push(...outcomes.map(({ id, ok }) => ({ id, ok })));
    },
  };
  const notifications = new WebPushNotifications(
    store,
    { send: async (subscription, payload) => void sent.push({ id: subscription.id, payload }) },
    { notifyRecipients: async ({ userIds }) => void published.push([...userIds]) },
    {
      activity: {
        read: async (userIds) =>
          new Map(
            userIds.flatMap((id) => (input.activity?.[id] ? [[id, input.activity[id]!]] : [])),
          ),
      },
      deferred: {
        defer: async (entry, dueAt) => void queued.push({ entry, dueAt }),
        reschedule: async () => {},
        takeMessages: async () => [],
      },
      now: () => input.now ?? NOW,
    },
  );
  return { notifications, sent, published, queued, recorded };
}

describe("a message's fan-out", () => {
  test("a pause or quiet hours leave a person out of push and in-page alike", async () => {
    const h = harness({
      notification: message([
        {
          userId: "paused",
          settings: settings({ pausedUntil: new Date(NOW.getTime() + MINUTE) }),
          subscriptions: [laptop],
        },
        // 10:00Z is 18:00 in Shanghai: outside this person's 22:00–08:00.
        {
          userId: "evening",
          settings: settings({
            quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60 },
          }),
          timeZone: "Asia/Shanghai",
          subscriptions: [{ ...laptop, id: "evening-laptop" }],
        },
        // 10:00 UTC is inside this person's 09:00–11:00.
        {
          userId: "quiet",
          settings: settings({
            quietHours: { enabled: true, startMinute: 9 * 60, endMinute: 11 * 60 },
          }),
          subscriptions: [{ ...laptop, id: "quiet-laptop" }],
        },
        { userId: "awake", subscriptions: [{ ...laptop, id: "awake-laptop" }] },
      ]),
    });
    await h.notifications.notifyMessage("message-a");
    expect(h.sent.map((delivery) => delivery.id).sort()).toEqual([
      "awake-laptop",
      "evening-laptop",
    ]);
    expect(h.published).toEqual([["evening", "awake"]]);
  });

  test("the preview and sound shape each person's payload", async () => {
    const h = harness({
      notification: message([
        { userId: "full", subscriptions: [{ ...laptop, id: "full" }] },
        {
          userId: "sender",
          settings: settings({ previewMode: "sender" }),
          subscriptions: [{ ...laptop, id: "sender" }],
        },
        {
          userId: "hidden",
          settings: settings({ previewMode: "hidden", sound: false }),
          subscriptions: [{ ...laptop, id: "hidden" }],
        },
      ]),
    });
    await h.notifications.notifyMessage("message-a");
    const payload = (id: string) => h.sent.find((delivery) => delivery.id === id)!.payload;
    expect(payload("full")).toEqual({
      title: "#general",
      body: "Alice: ship it",
      url: "/notifications/open?target=x",
      tag: "message:message-a",
    });
    expect(payload("sender")).toMatchObject({ title: "#general", body: "Alice sent a message" });
    expect(payload("hidden")).toMatchObject({
      title: "CoForge",
      body: "New message",
      silent: true,
    });
    expect(payload("full").silent).toBeUndefined();
  });

  test("a phone waits while the computer is in use; computers and unlabelled browsers never wait", async () => {
    const h = harness({
      notification: message([{ userId: "alice", subscriptions: [laptop, phone, oldBrowser] }]),
      activity: { alice: { lastInputAt: new Date(NOW.getTime() - MINUTE), reportedAt: NOW } },
    });
    await h.notifications.notifyMessage("message-a");
    expect(h.sent.map((delivery) => delivery.id).sort()).toEqual(["laptop", "old"]);
    expect(h.queued).toEqual([
      {
        entry: { messageId: "message-a", userId: "alice", firstQueuedAt: NOW },
        dueAt: new Date(NOW.getTime() + 2 * MINUTE),
      },
    ]);
  });

  test("with nobody at the computer, or immediate, the phone rings now", async () => {
    for (const [activity, mobileDelay] of [
      [undefined, "inactive"],
      [{ lastInputAt: NOW, reportedAt: NOW }, "immediate"],
    ] as const) {
      const h = harness({
        notification: message([
          { userId: "alice", settings: settings({ mobileDelay }), subscriptions: [phone] },
        ]),
        activity: activity ? { alice: activity } : {},
      });
      await h.notifications.notifyMessage("message-a");
      expect(h.sent.map((delivery) => delivery.id)).toEqual(["phone"]);
      expect(h.queued).toEqual([]);
    }
  });

  test("a queue that cannot take the phone's wait rings every device now", async () => {
    const sent: string[] = [];
    const notifications = new WebPushNotifications(
      {
        notificationForMessage: async () =>
          message([{ userId: "alice", subscriptions: [laptop, phone] }]),
        notificationForRecipient: async () => null,
        deferredNotification: async () => null,
        settingsFor: async () => ({ settings: DEFAULT_NOTIFICATION_SETTINGS, timeZone: "UTC" }),
        subscriptionsForUser: async () => [],
        saveSubscription: async () => {},
        removeSubscription: async () => {},
        removeSubscriptionById: async () => {},
        recordDeliveries: async () => {},
      },
      { send: async (subscription) => void sent.push(subscription.id) },
      undefined,
      {
        activity: { read: async () => new Map([["alice", { lastInputAt: NOW, reportedAt: NOW }]]) },
        deferred: {
          defer: async () => {
            throw new Error("Redis timed out");
          },
          reschedule: async () => {},
          takeMessages: async () => [],
        },
        now: () => NOW,
      },
    );
    expect(await notifications.notifyMessage("message-a")).toMatchObject({ sent: 2 });
    expect(sent.sort()).toEqual(["laptop", "phone"]);
  });

  test("each device's outcome is recorded once for the whole fan-out", async () => {
    let calls = 0;
    const recorded: string[] = [];
    const notifications = new WebPushNotifications(
      {
        notificationForMessage: async () =>
          message(
            Array.from({ length: 5 }, (_, index) => ({
              userId: `person-${index}`,
              subscriptions: [{ ...laptop, id: `laptop-${index}` }],
            })),
          ),
        notificationForRecipient: async () => null,
        deferredNotification: async () => null,
        settingsFor: async () => ({ settings: DEFAULT_NOTIFICATION_SETTINGS, timeZone: "UTC" }),
        subscriptionsForUser: async () => [],
        saveSubscription: async () => {},
        removeSubscription: async () => {},
        removeSubscriptionById: async () => {},
        recordDeliveries: async (outcomes) => {
          calls += 1;
          recorded.push(...outcomes.map((outcome) => `${outcome.id}:${outcome.ok}`));
        },
      },
      { send: async () => {} },
      undefined,
      { now: () => NOW },
    );
    await notifications.notifyMessage("message-a");
    expect(calls).toBe(1);
    expect(recorded.sort()).toEqual([0, 1, 2, 3, 4].map((index) => `laptop-${index}:true`));
  });
});

describe("the Settings test notification", () => {
  test("goes to every device, whatever the settings, with each one's outcome", async () => {
    const sent: string[] = [];
    const removed: string[] = [];
    const devices = [laptop, phone, oldBrowser];
    const store: WebPushSubscriptionStore = {
      notificationForMessage: async () => null,
      notificationForRecipient: async () => null,
      deferredNotification: async () => null,
      settingsFor: async () => ({ settings: DEFAULT_NOTIFICATION_SETTINGS, timeZone: "UTC" }),
      subscriptionsForUser: async () => devices,
      saveSubscription: async () => {},
      removeSubscription: async () => {},
      removeSubscriptionById: async (id) => void removed.push(id),
      recordDeliveries: async () => {},
    };
    const notifications = new WebPushNotifications(store, {
      send: async (subscription, payload) => {
        expect(payload).toMatchObject({ forceDisplay: true, title: "CoForge" });
        if (subscription.id === "old") throw new WebPushDeliveryError(410);
        sent.push(subscription.id);
      },
    });
    expect(await notifications.sendTestToDevices("alice", "en", "acme")).toEqual([
      { id: "laptop", outcome: "sent" },
      { id: "phone", outcome: "sent" },
      { id: "old", outcome: "removed" },
    ]);
    expect(sent).toEqual(["laptop", "phone"]);
    expect(removed).toEqual(["old"]);
  });
});
