import { expect } from "bun:test";

import { isAppErrorCode } from "#src/lib/app-error";
import { deriveWebhookSecret } from "#src/server/app-notifications/webhook-secret.server";
import { createWebhookDelivery } from "#src/server/app-notifications/webhook-delivery-composition.server";

import {
  db,
  KEY,
  loopback,
  received,
  endpoint,
  jobFor,
  statusOf,
  withFixture,
  testWithDatabase,
  webhooks,
  useWebhookDeliveryEnvironment,
} from "./helpers/app-webhook-delivery-fixture";

/** Setup: a webhook switched on before it has an endpoint (Raft's "Setup"). */
useWebhookDeliveryEnvironment();

const row = (appId: string) => db!.appWebhook.findUniqueOrThrow({ where: { appId } });

testWithDatabase(
  "enabling without an endpoint is Setup: no secret, nothing delivered",
  async () => {
    await withFixture(async (f) => {
      const change = await webhooks().enable(f.actor, f.key);
      expect(change.signingSecret).toBeUndefined();
      expect(change.webhook).toMatchObject({ status: "setup", enabled: true, endpointUrl: null });
      expect(await row(f.appId)).toMatchObject({
        enabled: true,
        endpointUrl: null,
        secretGeneration: 1,
      });

      await createWebhookDelivery(loopback).deliver(jobFor(f));
      expect(received).toHaveLength(0);
      expect(await statusOf(f.installationId)).toBeNull();

      // Fan-out has nowhere to send either.
      const store = await db!.appInstallation.count({
        where: { appId: f.appId, app: { webhook: { enabled: true, endpointUrl: { not: null } } } },
      });
      expect(store).toBe(0);
    });
  },
);

testWithDatabase(
  "enabling again changes nothing; the first endpoint returns the secret once",
  async () => {
    await withFixture(async (f) => {
      await webhooks().enable(f.actor, f.key);
      const again = await webhooks().enable(f.actor, f.key);
      expect(again.webhook.revision).toBe(1);

      const saved = await webhooks().save(f.actor, f.key, endpoint());
      expect(saved.webhook.status).toBe("enabled");
      expect(saved.signingSecret).toBe(deriveWebhookSecret(KEY, f.appId, 1));
      // Moving an enabled endpoint issues no secret.
      const moved = await webhooks().save(f.actor, f.key, "https://hooks.example/other");
      expect(moved.signingSecret).toBeUndefined();
      expect((await row(f.appId)).secretGeneration).toBe(1);
    });
  },
);

testWithDatabase(
  "disabling a Setup webhook is Off, and enabling again is a new generation",
  async () => {
    await withFixture(async (f) => {
      await webhooks().enable(f.actor, f.key);
      const off = await webhooks().disable(f.actor, f.key);
      expect(off.webhook).toMatchObject({ status: "off", enabled: false });
      await webhooks().enable(f.actor, f.key);
      expect((await row(f.appId)).secretGeneration).toBe(2);
    });
  },
);

testWithDatabase("rotating needs an endpoint", async () => {
  await withFixture(async (f) => {
    await webhooks().enable(f.actor, f.key);
    const refusal = await webhooks()
      .rotate(f.actor, f.key)
      .catch((e: unknown) => e);
    expect(isAppErrorCode(refusal, "CONFLICT")).toBe(true);
  });
});

testWithDatabase(
  "members cannot enable; the app list statuses are for owners and admins",
  async () => {
    await withFixture(async (f) => {
      const refusal = await webhooks()
        .enable(f.memberActor, f.key)
        .catch((e: unknown) => e);
      expect(isAppErrorCode(refusal, "ACCESS_DENIED")).toBe(true);

      expect(await webhooks().workspaceStatuses(f.actor)).toEqual(new Map());
      await webhooks().enable(f.actor, f.key);
      expect(await webhooks().workspaceStatuses(f.actor)).toEqual(new Map([[f.key, "setup"]]));
      await webhooks().save(f.actor, f.key, endpoint());
      expect(await webhooks().workspaceStatuses(f.actor)).toEqual(new Map([[f.key, "enabled"]]));
      expect(await webhooks().workspaceStatuses(f.memberActor)).toBeNull();
    });
    await withFixture(async (f) => {
      expect(await webhooks().workspaceStatuses(f.actor)).toBeNull();
    }, "off");
  },
);
