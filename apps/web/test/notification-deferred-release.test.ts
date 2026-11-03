import { describe, expect, test } from "bun:test";

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type ComputerActivity,
  type NotificationSettings,
} from "#src/server/notifications/notification-rules.server";
import type {
  DeferredPush,
  DeferredPushQueue,
} from "#src/server/notifications/deferred-mobile-pushes.server";
import {
  WebPushNotifications,
  type DeferredNotification,
  type WebPushPayload,
  type WebPushSubscriptionStore,
} from "#src/server/notifications/web-push-notifications.server";

/**
 * A person's waiting phone notifications when their wait ends (task #467). While the computer is
 * in use the check reads only their settings and activity, never the messages. Once they leave
 * it, their phones get the newest unread message of each conversation, not one per message; read,
 * gone and 12-hour-old ones are dropped, and so is everything during a pause or quiet hours.
 */

const NOW = new Date("2026-11-03T10:00:00Z");
const MINUTE = 60_000;
const laptop = {
  id: "laptop",
  endpoint: "https://push.example/l",
  p256dh: "p",
  auth: "a",
  deviceKind: "desktop",
};
const phone = {
  id: "phone",
  endpoint: "https://push.example/p",
  p256dh: "p",
  auth: "a",
  deviceKind: "mobile",
};
const settings = (changes: Partial<NotificationSettings> = {}) => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  ...changes,
});

const waitingMessage = (
  messageId: string,
  changes: { conversationId?: string; read?: boolean } = {},
): DeferredNotification => ({
  conversationId: changes.conversationId ?? "general",
  title: "#general",
  body: `Alice: ${messageId}`,
  sender: "Alice",
  url: `/open/${messageId}`,
  read: changes.read ?? false,
  recipient: {
    userId: "alice",
    settings: settings(),
    timeZone: "UTC",
    subscriptions: [laptop, phone],
  },
});

function harness(input: {
  entries: DeferredPush[];
  messages?: Record<string, DeferredNotification | null>;
  personSettings?: NotificationSettings;
  activity?: ComputerActivity;
}) {
  const sent: Array<{ id: string; payload: WebPushPayload }> = [];
  const read: string[] = [];
  const rescheduled: Date[] = [];
  let taken = false;
  const store: WebPushSubscriptionStore = {
    notificationForMessage: async () => null,
    notificationForRecipient: async () => null,
    deferredNotification: async (messageId) => {
      read.push(messageId);
      return input.messages?.[messageId] ?? null;
    },
    settingsFor: async () => ({ settings: input.personSettings ?? settings(), timeZone: "UTC" }),
    subscriptionsForUser: async () => [],
    saveSubscription: async () => {},
    removeSubscription: async () => {},
    removeSubscriptionById: async () => {},
    recordDeliveries: async () => {},
  };
  const queue: DeferredPushQueue = {
    defer: async () => {},
    reschedule: async (_userId, dueAt) => void rescheduled.push(dueAt),
    takeMessages: async () => {
      taken = true;
      return input.entries;
    },
  };
  const notifications = new WebPushNotifications(
    store,
    { send: async (subscription, payload) => void sent.push({ id: subscription.id, payload }) },
    undefined,
    {
      activity: { read: async () => new Map(input.activity ? [["alice", input.activity]] : []) },
      deferred: queue,
      now: () => NOW,
    },
  );
  return {
    release: () => notifications.releaseDeferred("alice"),
    sent,
    read,
    rescheduled,
    taken: () => taken,
  };
}

const entry = (messageId: string, minutesAgo = 5): DeferredPush => ({
  messageId,
  userId: "alice",
  firstQueuedAt: new Date(NOW.getTime() - minutesAgo * MINUTE),
});

describe("a person's waiting phone notifications", () => {
  test("still at the computer: wait again, without reading a single message", async () => {
    const h = harness({
      entries: [entry("m1"), entry("m2")],
      activity: { lastInputAt: new Date(NOW.getTime() - 30_000), reportedAt: NOW },
    });
    expect(await h.release()).toEqual({ outcome: "waiting", sent: 0 });
    expect(h.rescheduled).toEqual([new Date(NOW.getTime() + 150_000)]);
    expect(h.read).toEqual([]);
    expect(h.taken()).toBe(false);
  });

  test("away from it: the phone gets the newest unread message of each conversation", async () => {
    const h = harness({
      entries: [entry("m1", 9), entry("m2", 7), entry("m3", 6), entry("d1", 8)],
      messages: {
        m1: waitingMessage("m1"),
        m2: waitingMessage("m2"),
        m3: waitingMessage("m3", { read: true }),
        d1: waitingMessage("d1", { conversationId: "dm-bob" }),
      },
    });
    expect(await h.release()).toEqual({ outcome: "sent", sent: 2 });
    // m3 was read, so m2 is general's newest unread one; never the laptop.
    expect(h.sent.map((delivery) => [delivery.id, delivery.payload.url]).sort()).toEqual([
      ["phone", "/open/d1"],
      ["phone", "/open/m2"],
    ]);
  });

  test("read, gone, or waiting longer than 12 hours: dropped", async () => {
    const h = harness({
      entries: [entry("read"), entry("gone"), entry("old", 12 * 60 + 1)],
      messages: { read: waitingMessage("read", { read: true }), old: waitingMessage("old") },
    });
    expect(await h.release()).toEqual({ outcome: "sent", sent: 0 });
    expect(h.sent).toEqual([]);
    // The 12-hour-old one is dropped without being read.
    expect(h.read.sort()).toEqual(["gone", "read"]);
  });

  test("paused or in quiet hours: everything waiting is dropped", async () => {
    const h = harness({
      entries: [entry("m1")],
      messages: { m1: waitingMessage("m1") },
      personSettings: settings({ pausedUntil: new Date(NOW.getTime() + MINUTE) }),
    });
    expect(await h.release()).toEqual({ outcome: "suppressed", sent: 0 });
    expect(h.taken()).toBe(true);
    expect(h.sent).toEqual([]);
  });
});
