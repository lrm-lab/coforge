import { expect, spyOn } from "bun:test";

import { Webhook } from "standardwebhooks";

import { newAppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import {
  APP_NOTIFICATION_DELIVERY_QUEUE,
  appNotificationDeliveryJobId,
} from "#src/server/app-notifications/app-notification-jobs";
import { startAppNotificationQueue } from "#src/server/app-notifications/app-notification-queue.server";
import { AppNotifications } from "#src/server/app-notifications/app-notifications.server";

import {
  connectionString,
  db,
  PUBLIC_ADDRESS,
  toReceiver,
  received,
  endpoint,
  withFixture,
  testWithDatabase,
  webhooks,
  state,
  useWebhookDeliveryEnvironment,
} from "./helpers/app-webhook-delivery-fixture";
import { subscribeToMemberAdded } from "./helpers/app-notification-subscription";

/** App notifications through pg-boss to a signed webhook. */
useWebhookDeliveryEnvironment();

const END_TO_END_TIMEOUT_MS = 60_000;

testWithDatabase(
  "through pg-boss: an event is fanned out, retried after a 503 with the same message id, and delivered",
  async () => {
    // The production delivery handler runs; only the network below the egress is replaced.
    const lookup = spyOn(Bun.dns, "lookup").mockResolvedValue([PUBLIC_ADDRESS] as never);
    const forwarded = spyOn(globalThis, "fetch").mockImplementation(toReceiver as never);
    const proxyVariables = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
    const proxies = proxyVariables.map((name) => [name, process.env[name]] as const);
    for (const name of proxyVariables) delete process.env[name];
    try {
      await withFixture(async (f) => {
        const boss = await startAppNotificationQueue(connectionString);
        await subscribeToMemberAdded(db!, f.appId);
        const { signingSecret: secret } = await webhooks().save(f.actor, f.key, endpoint());
        state.script = [503, 204];
        const event = newAppNotificationEvent({
          type: "workspace.member_added",
          workspaceId: f.workspace.id,
          data: { user_id: crypto.randomUUID(), role: "member" },
        });
        await db!.$transaction((tx) => AppNotifications.record(tx, f.workspace, event));

        const deadline = Date.now() + END_TO_END_TIMEOUT_MS - 10_000;
        while (received.length < 2 && Date.now() < deadline) await Bun.sleep(200);
        expect(received).toHaveLength(2);
        const messageId = `msg_${appNotificationDeliveryJobId(event.id, f.installationId)}`;
        expect(received.map((r) => r.headers.get("webhook-id"))).toEqual([messageId, messageId]);
        for (const { headers, body } of received) {
          new Webhook(secret!).verify(body, Object.fromEntries(headers));
        }
        // The receiver answering is not the job completing: pg-boss marks it done after the
        // handler returns, so wait for that state.
        const findJob = async () =>
          (
            await boss.findJobs(APP_NOTIFICATION_DELIVERY_QUEUE, {
              data: { eventId: event.id },
            })
          )[0];
        while ((await findJob())?.state !== "completed" && Date.now() < deadline) {
          await Bun.sleep(200);
        }
        expect(await findJob()).toMatchObject({ state: "completed", retryCount: 1 });
      });
    } finally {
      for (const [name, value] of proxies) if (value !== undefined) process.env[name] = value;
      lookup.mockRestore();
      forwarded.mockRestore();
    }
  },
  END_TO_END_TIMEOUT_MS,
);
