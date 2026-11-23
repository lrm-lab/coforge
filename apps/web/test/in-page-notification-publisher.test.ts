import { describe, expect, test } from "bun:test";

import { createCentrifugoNotificationPublisher } from "#src/server/notifications/in-page-notification-publisher.server";
import {
  decodeNotificationAvailableEvent,
  userConversationChannel,
} from "#src/features/conversations/conversation-realtime";

const decision = {
  messageId: "message-a",
  workspaceId: "workspace-a",
  at: 1795392000000,
  pushInstallations: ["a".repeat(64)],
  legacyPush: ["b".repeat(64)],
};

describe("createCentrifugoNotificationPublisher", () => {
  test("publishes ready recipients in a single v2 batch with private routing decisions", async () => {
    const calls: unknown[] = [];
    const publisher = createCentrifugoNotificationPublisher({
      publishJsonBatch: async (publications) => {
        calls.push(publications);
        for (const { data } of publications)
          expect(data).toEqual(decodeNotificationAvailableEvent(data));
        return publications.map(() => ({ status: "fulfilled", value: undefined }));
      },
    });

    const other = { ...decision, pushInstallations: [], legacyPush: [] };
    await Promise.all([
      publisher.notifyRecipient({ ...decision, userId: "user-1" }),
      publisher.notifyRecipient({ ...other, userId: "user-2" }),
    ]);

    expect(calls).toEqual([
      [
        {
          channel: userConversationChannel("user-1"),
          data: { type: "notification.available.v2", ...decision },
          idempotencyKey: "notification:v2:message-a",
        },
        {
          channel: userConversationChannel("user-2"),
          data: { type: "notification.available.v2", ...other },
          idempotencyKey: "notification:v2:message-a",
        },
      ],
    ]);
  });

  test("settles each publication independently when Centrifugo refuses one", async () => {
    const denied = new Error("publication refused");
    const publisher = createCentrifugoNotificationPublisher({
      publishJsonBatch: async () => [
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: denied },
      ],
    });

    expect(
      await Promise.allSettled([
        publisher.notifyRecipient({ ...decision, userId: "first" }),
        publisher.notifyRecipient({ ...decision, userId: "second" }),
      ]),
    ).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: denied },
    ]);
  });
});
