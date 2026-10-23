import { expect, spyOn } from "bun:test";

import { Webhook } from "standardwebhooks";

import { isAppErrorCode } from "#src/lib/app-error";

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
  state,
  useWebhookDeliveryEnvironment,
} from "./helpers/app-webhook-delivery-fixture";

/** Signing, secrets and rotation of app webhook deliveries. */
useWebhookDeliveryEnvironment();

testWithDatabase("a delivery is signed so the secret returned at enable verifies it", async () => {
  await withFixture(async (f) => {
    const { signingSecret: secret, webhook } = await webhooks().save(f.actor, f.key, endpoint());
    expect(secret).toStartWith("whsec_");
    expect(webhook).toMatchObject({ enabled: true, endpointUrl: endpoint(), revision: 1 });
    const job = jobFor(f);
    await createWebhookDelivery(loopback).deliver(job);

    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers.get("webhook-id")).toBe(`msg_${job.id}`);
    expect(headers.get("content-type")).toBe("application/json");
    new Webhook(secret!).verify(body, Object.fromEntries(headers));
    expect(JSON.parse(body)).toEqual({
      type: "workspace.member_added",
      timestamp: job.data.event.timestamp,
      data: {
        installation_id: f.installationId,
        workspace_id: f.workspace.id,
        user_id: job.data.event.data.userId,
        role: "member",
      },
    });
    expect(await statusOf(f.installationId)).toMatchObject({
      lastError: null,
      consecutiveFailures: 0,
      disabledReason: null,
    });
    expect((await statusOf(f.installationId))?.lastDeliveryAt).toBeInstanceOf(Date);
  });
});

testWithDatabase(
  "saving again keeps the secret and returns none; the secret is never stored",
  async () => {
    await withFixture(async (f) => {
      const first = await webhooks().save(f.actor, f.key, endpoint());
      const second = await webhooks().save(f.actor, f.key, `${endpoint()}?v=2`);
      expect(second.signingSecret).toBeUndefined();
      expect(second.webhook).toMatchObject({ revision: 2, secretGeneration: 1 });
      await createWebhookDelivery(loopback).deliver(jobFor(f));
      const { headers, body } = received[0]!;
      new Webhook(first.signingSecret!).verify(body, Object.fromEntries(headers));
      const row = JSON.stringify(await db!.appWebhook.findUnique({ where: { appId: f.appId } }));
      expect(row).not.toContain(first.signingSecret!);
      expect(row).not.toContain(first.signingSecret!.slice("whsec_".length));
    });
  },
);

testWithDatabase(
  "during a rotation both secrets sign; an unrelated secret does not verify",
  async () => {
    await withFixture(async (f) => {
      const { signingSecret: previous } = await webhooks().save(f.actor, f.key, endpoint());
      const rotated = await webhooks().rotate(f.actor, f.key);
      expect(rotated.signingSecret).toStartWith("whsec_");
      expect(rotated.signingSecret).not.toBe(previous);
      expect(rotated.webhook.previousSecretValidUntil).toBeInstanceOf(Date);

      await createWebhookDelivery(loopback).deliver(jobFor(f));
      const { headers, body } = received[0]!;
      expect(headers.get("webhook-signature")!.split(" ")).toHaveLength(2);
      const plain = Object.fromEntries(headers);
      new Webhook(rotated.signingSecret!).verify(body, plain);
      new Webhook(previous!).verify(body, plain);
      expect(() =>
        new Webhook(`whsec_${Buffer.alloc(32, 7).toString("base64")}`).verify(body, plain),
      ).toThrow();

      // Past the overlap only the new secret signs.
      await db!.appWebhook.update({
        where: { appId: f.appId },
        data: { previousSecretValidUntil: new Date(Date.now() - 1_000) },
      });
      received.length = 0;
      await createWebhookDelivery(loopback).deliver(jobFor(f));
      const after = received[0]!;
      expect(after.headers.get("webhook-signature")!.split(" ")).toHaveLength(1);
      new Webhook(rotated.signingSecret!).verify(after.body, Object.fromEntries(after.headers));
      expect(() =>
        new Webhook(previous!).verify(after.body, Object.fromEntries(after.headers)),
      ).toThrow();
      expect((await webhooks().read(f.actor, f.key))?.previousSecretValidUntil).toBeNull();
    });
  },
);

testWithDatabase(
  "disabling removes the endpoint at once; enabling again makes a new secret",
  async () => {
    await withFixture(async (f) => {
      const { signingSecret: first } = await webhooks().save(f.actor, f.key, endpoint());
      state.script = [410];
      await createWebhookDelivery(loopback).deliver(jobFor(f));
      expect((await statusOf(f.installationId))?.disabledReason).toBe("endpoint_rejected");

      const { webhook } = await webhooks().disable(f.actor, f.key);
      expect(webhook).toMatchObject({ enabled: false, endpointUrl: null });
      expect(await db!.appWebhook.findUnique({ where: { appId: f.appId } })).toMatchObject({
        enabled: false,
        endpointUrl: null,
        previousSecretGeneration: null,
      });
      expect(await statusOf(f.installationId)).toBeNull();
      await createWebhookDelivery(loopback).deliver(jobFor(f));
      expect(received).toHaveLength(1);

      const again = await webhooks().save(f.actor, f.key, endpoint());
      expect(again.signingSecret).toStartWith("whsec_");
      expect(again.signingSecret).not.toBe(first);
      expect(again.webhook.secretGeneration).toBe(2);
      expect(await statusOf(f.installationId)).toBeNull();
      await expect(webhooks().rotate(f.actor, f.key)).resolves.toBeDefined();
      await webhooks().disable(f.actor, f.key);
      const refusal = await webhooks()
        .rotate(f.actor, f.key)
        .catch((error: unknown) => error);
      expect(isAppErrorCode(refusal, "CONFLICT")).toBe(true);
    });
  },
);

testWithDatabase(
  "no secret, signing key or response body reaches a log, a status or the database",
  async () => {
    await withFixture(async (f) => {
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
        spyOn(console, method).mockImplementation(() => {}),
      );
      try {
        const { signingSecret: secret } = await webhooks().save(f.actor, f.key, endpoint());
        state.script = [500, 204];
        const delivery = createWebhookDelivery(loopback);
        const job = jobFor(f);
        await delivery.deliver(job).catch(() => {});
        await delivery.deliver({ ...job, retryCount: 1 });
        const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
        for (const forbidden of [
          secret!,
          secret!.slice("whsec_".length),
          KEY,
          "secret response body",
        ]) {
          expect(logged).not.toContain(forbidden);
          expect(JSON.stringify(await statusOf(f.installationId))).not.toContain(forbidden);
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  },
);
