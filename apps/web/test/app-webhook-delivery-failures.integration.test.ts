import { expect } from "bun:test";

import {
  APP_WEBHOOK_ENDPOINT_INVALID,
  APP_WEBHOOK_ENDPOINT_UNREACHABLE,
} from "#src/features/apps/app-webhook";

import { isAppErrorCode } from "#src/lib/app-error";

import { DELIVERY_QUEUE_OPTIONS } from "#src/server/app-notifications/app-notification-jobs";

import { createWebhookDelivery } from "#src/server/app-notifications/webhook-delivery-composition.server";
import { WebhookDeliveryFailed } from "#src/server/app-notifications/webhook-delivery.server";

import { OutboundEgress } from "#src/server/egress/outbound-egress.server";

import {
  db,
  toReceiver,
  loopback,
  strict,
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

/** Failed, stopped and refused app webhook deliveries. */
useWebhookDeliveryEnvironment();

testWithDatabase(
  "a 503 throws for a retry, the retry keeps the message id and succeeds on 204",
  async () => {
    await withFixture(async (f) => {
      await webhooks().save(f.actor, f.key, endpoint());
      state.script = [503, 204];
      const delivery = createWebhookDelivery(loopback);
      const job = jobFor(f);
      await expect(delivery.deliver(job)).rejects.toThrow(WebhookDeliveryFailed);
      const failed = await statusOf(f.installationId);
      expect(failed).toMatchObject({
        lastError: "http_503",
        consecutiveFailures: 1,
        disabledReason: null,
      });
      expect(failed?.nextAttemptAt!.getTime()).toBeGreaterThan(failed!.lastAttemptAt!.getTime());

      await delivery.deliver({ ...job, retryCount: 1 });
      expect(received.map((r) => r.headers.get("webhook-id"))).toEqual([
        `msg_${job.id}`,
        `msg_${job.id}`,
      ]);
      expect(await statusOf(f.installationId)).toMatchObject({
        lastError: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
      });
      expect((await statusOf(f.installationId))?.lastDeliveryAt).toBeInstanceOf(Date);
    });
  },
);

testWithDatabase("a 410 completes the job and stops deliveries to that installation", async () => {
  await withFixture(async (f) => {
    await webhooks().save(f.actor, f.key, endpoint());
    state.script = [410];
    const delivery = createWebhookDelivery(loopback);
    await delivery.deliver(jobFor(f));
    expect(await statusOf(f.installationId)).toMatchObject({
      disabledReason: "endpoint_rejected",
      lastError: "http_410",
      nextAttemptAt: null,
    });
    await delivery.deliver(jobFor(f));
    expect(received).toHaveLength(1);
  });
});

testWithDatabase("a redirect is a failure and is never followed", async () => {
  await withFixture(async (f) => {
    await webhooks().save(f.actor, f.key, endpoint());
    state.script = [302];
    await expect(createWebhookDelivery(loopback).deliver(jobFor(f))).rejects.toThrow("http_302");
    expect(received).toHaveLength(1);
  });
});

testWithDatabase("the last retry that fails stops deliveries instead of throwing", async () => {
  await withFixture(async (f) => {
    await webhooks().save(f.actor, f.key, endpoint());
    state.script = [500];
    await createWebhookDelivery(loopback).deliver(
      jobFor(f, { retryCount: DELIVERY_QUEUE_OPTIONS.retryLimit }),
    );
    expect(await statusOf(f.installationId)).toMatchObject({
      disabledReason: "retries_exhausted",
      lastError: "http_500",
    });
    await createWebhookDelivery(loopback).deliver(jobFor(f));
    expect(received).toHaveLength(1);
  });
});

testWithDatabase("an endpoint that is not public is refused at save and at delivery", async () => {
  await withFixture(async (f) => {
    for (const url of [
      "https://10.0.0.8/hook",
      "https://169.254.169.254/latest",
      "https://[::1]/hook",
      "https://127.0.0.1:1/hook",
    ]) {
      const refusal = await webhooks(strict)
        .save(f.actor, f.key, url)
        .catch((error: unknown) => error);
      expect(isAppErrorCode(refusal, "INVALID_INPUT")).toBe(true);
      expect((refusal as { errorId?: string }).errorId).toBe(APP_WEBHOOK_ENDPOINT_UNREACHABLE);
    }
    for (const url of [
      "http://hooks.example/in",
      "http://127.0.0.1:8080/in",
      "http://localhost/in",
      "https://u:p@hooks.example/in",
      "https://hooks.example/in#f",
      "https://HOOKS.example/in",
    ]) {
      const refusal = await webhooks(strict)
        .save(f.actor, f.key, url)
        .catch((error: unknown) => error);
      expect((refusal as { errorId?: string }).errorId).toBe(APP_WEBHOOK_ENDPOINT_INVALID);
    }
    expect((await webhooks().read(f.actor, f.key))?.enabled).toBe(false);

    // An endpoint that resolved publicly at save and resolves privately later is refused again.
    await webhooks().save(f.actor, f.key, `${endpoint()}`);
    const rebound = new OutboundEgress({
      resolve: async () => [{ address: "10.0.0.8", family: 4 }],
      fetch: toReceiver,
    });
    await expect(createWebhookDelivery(rebound).deliver(jobFor(f))).rejects.toThrow(
      "address_not_public",
    );
    expect(received).toHaveLength(0);
    expect(await statusOf(f.installationId)).toMatchObject({ lastError: "address_not_public" });
  });
});

testWithDatabase("a stale attempt does not write over a newer endpoint's status", async () => {
  await withFixture(async (f) => {
    await webhooks().save(f.actor, f.key, endpoint());
    const store = (await import("#src/server/db/repositories/app-webhook.repositories.server"))
      .PrismaAppWebhookStore;
    const written = await new store(db!).recordAttempt({
      installationId: f.installationId,
      revision: 0,
      at: new Date(),
      outcome: {
        kind: "failed",
        error: "http_500",
        consecutiveFailures: 1,
        nextAttemptAt: null,
        disabledReason: "endpoint_rejected",
      },
    });
    expect(written).toBe(false);
    expect(await statusOf(f.installationId)).toBeNull();
  });
});

testWithDatabase("an event over the size limit stops deliveries without retrying", async () => {
  await withFixture(async (f) => {
    await webhooks().save(f.actor, f.key, endpoint());
    const job = jobFor(f);
    const oversized = {
      ...job,
      data: {
        ...job.data,
        event: { ...job.data.event, data: { ...job.data.event.data, role: "x".repeat(25_000) } },
      },
    } as typeof job;
    await createWebhookDelivery(loopback).deliver(oversized);
    expect(received).toHaveLength(0);
    const status = await statusOf(f.installationId);
    expect(status).toMatchObject({
      disabledReason: "payload_too_large",
      lastError: "body_too_large",
      nextAttemptAt: null,
    });
    expect(status?.disabledAt).toBeInstanceOf(Date);
  });
});

testWithDatabase("a stored endpoint the rules no longer accept stops deliveries", async () => {
  await withFixture(async (f) => {
    await webhooks().save(f.actor, f.key, endpoint());
    await db!.appWebhook.update({
      where: { appId: f.appId },
      data: { endpointUrl: "https://hooks.example:99999/hook" },
    });
    await createWebhookDelivery(loopback).deliver(jobFor(f));
    expect(received).toHaveLength(0);
    expect(await statusOf(f.installationId)).toMatchObject({
      disabledReason: "endpoint_invalid",
      lastError: "endpoint_invalid",
    });
  });
});

testWithDatabase("an attempt counts once however often it is recorded", async () => {
  await withFixture(async (f) => {
    await webhooks().save(f.actor, f.key, endpoint());
    state.script = [500, 500, 500];
    const delivery = createWebhookDelivery(loopback);
    const job = jobFor(f);
    await delivery.deliver(job).catch(() => {});
    await delivery.deliver(job).catch(() => {});
    expect((await statusOf(f.installationId))?.consecutiveFailures).toBe(1);
    await delivery.deliver({ ...job, retryCount: 2 }).catch(() => {});
    expect((await statusOf(f.installationId))?.consecutiveFailures).toBe(3);
  });
});

testWithDatabase(
  "saving the endpoint again starts deliveries again; a status of an older revision is ignored",
  async () => {
    await withFixture(async (f) => {
      await webhooks().save(f.actor, f.key, endpoint());
      state.script = [410];
      const delivery = createWebhookDelivery(loopback);
      await delivery.deliver(jobFor(f));
      await delivery.deliver(jobFor(f)); // skipped: stopped
      expect(received).toHaveLength(1);

      await webhooks().save(f.actor, f.key, `${endpoint()}?v=2`);
      await delivery.deliver(jobFor(f));
      expect(received).toHaveLength(2);

      // A stop written at an earlier revision (a status the change did not clear in time) is not
      // about the current endpoint.
      await db!.appInstallationWebhookStatus.deleteMany({});
      await db!.appInstallationWebhookStatus.create({
        data: {
          installationId: f.installationId,
          revision: 1,
          disabledReason: "endpoint_rejected",
          disabledAt: new Date(),
        },
      });
      await delivery.deliver(jobFor(f));
      expect(received).toHaveLength(3);
    });
  },
);
