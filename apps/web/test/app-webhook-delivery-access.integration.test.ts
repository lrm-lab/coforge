import { expect, spyOn } from "bun:test";

import { APP_NOTIFICATIONS_OFF, APP_WEBHOOK_UNAVAILABLE } from "#src/features/apps/app-webhook";

import { isAppErrorCode } from "#src/lib/app-error";

import { createWebhookDelivery } from "#src/server/app-notifications/webhook-delivery-composition.server";

import {
  forgetAppWebhookKey,
  rememberAppWebhookKey,
} from "#src/server/app-notifications/webhook-secret.server";

import {
  db,
  RUN,
  KEY,
  loopback,
  received,
  endpoint,
  fixture,
  jobFor,
  statusOf,
  withFixture,
  testWithDatabase,
  webhooks,
  useWebhookDeliveryEnvironment,
  nextOnSlug,
} from "./helpers/app-webhook-delivery-fixture";

/** Who may change an app webhook, the flag, the key, and what a view shows. */
useWebhookDeliveryEnvironment();

testWithDatabase("only an owner or admin of the app's Workspace changes the webhook", async () => {
  await withFixture(async (f) => {
    const refusal = await webhooks()
      .save(f.memberActor, f.key, endpoint())
      .catch((e: unknown) => e);
    expect(isAppErrorCode(refusal, "ACCESS_DENIED")).toBe(true);
    const other = await fixture();
    try {
      const foreign = await webhooks()
        .save(other.actor, f.key, endpoint())
        .catch((e: unknown) => e);
      expect(isAppErrorCode(foreign, "NOT_FOUND")).toBe(true);
    } finally {
      await other.cleanup();
    }
    expect(await db!.appWebhook.findUnique({ where: { appId: f.appId } })).toBeNull();
  });
});

testWithDatabase("with the flag off nothing is enabled, read or delivered", async () => {
  await withFixture(async (f) => {
    const refusal = await webhooks()
      .save(f.actor, f.key, endpoint())
      .catch((error: unknown) => error);
    expect(isAppErrorCode(refusal, "ACCESS_DENIED")).toBe(true);
    expect((refusal as { errorId?: string }).errorId).toBe(APP_NOTIFICATIONS_OFF);
    expect(await webhooks().read(f.actor, f.key)).toBeNull();
  }, "off");

  // A webhook saved while the flag was on is skipped once the flag is off for its Workspace.
  await withFixture(async (f) => {
    await webhooks().save(f.actor, f.key, endpoint());
    await db!.workspace.update({
      where: { id: f.workspace.id },
      data: { slug: `hook-off-${RUN}-${nextOnSlug}` },
    });
    await createWebhookDelivery(loopback).deliver(jobFor(f));
    expect(received).toHaveLength(0);
    expect(await statusOf(f.installationId)).toBeNull();
  });
});

testWithDatabase(
  "without COFORGE_APP_WEBHOOK_KEY a webhook cannot be enabled and a delivery is skipped, not stopped",
  async () => {
    await withFixture(async (f) => {
      forgetAppWebhookKey();
      const refusal = await webhooks()
        .save(f.actor, f.key, endpoint())
        .catch((error: unknown) => error);
      expect(isAppErrorCode(refusal, "TEMPORARILY_UNAVAILABLE")).toBe(true);
      expect((refusal as { errorId?: string }).errorId).toBe(APP_WEBHOOK_UNAVAILABLE);

      rememberAppWebhookKey(KEY);
      await webhooks().save(f.actor, f.key, endpoint());
      await createWebhookDelivery(loopback).deliver(jobFor(f)); // the key is present again
      received.length = 0;

      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        forgetAppWebhookKey();
        const delivery = createWebhookDelivery(loopback);
        await delivery.deliver(jobFor(f));
        await delivery.deliver(jobFor(f));
        expect(errors.mock.calls).toHaveLength(1);
        expect(JSON.stringify(errors.mock.calls)).toContain("webhook_key_unavailable");
      } finally {
        errors.mockRestore();
      }
      expect(received).toHaveLength(0);
      expect(await statusOf(f.installationId)).toMatchObject({
        lastError: "key_unavailable",
        disabledReason: null,
        disabledAt: null,
        nextAttemptAt: null,
      });

      // The outage did not stop the installation: the next delivery with the key goes out.
      rememberAppWebhookKey(KEY);
      await createWebhookDelivery(loopback).deliver(jobFor(f));
      expect(received).toHaveLength(1);
      expect(await statusOf(f.installationId)).toMatchObject({ lastError: null });
    });
  },
);

testWithDatabase(
  "a delivery with no installation, no webhook or a deleted app is skipped",
  async () => {
    await withFixture(async (f) => {
      const delivery = createWebhookDelivery(loopback);
      await delivery.deliver(jobFor(f)); // no webhook yet
      await delivery.deliver({
        ...jobFor(f),
        data: { ...jobFor(f).data, installationId: crypto.randomUUID() },
      });
      await webhooks().save(f.actor, f.key, endpoint());
      await db!.appInstallation.delete({ where: { id: f.installationId } });
      await delivery.deliver(jobFor(f));
      expect(received).toHaveLength(0);
    });
  },
);

testWithDatabase(
  "the webhook view lists only the caller's own Workspace's installations",
  async () => {
    await withFixture(async (f) => {
      const other = await fixture();
      try {
        await webhooks().save(f.actor, f.key, endpoint());
        await db!.appInstallation.create({
          data: { appId: f.appId, workspaceId: other.workspace.id },
        });
        const view = await webhooks().read(f.actor, f.key);
        expect(view?.installations.map((i) => i.installationId)).toEqual([f.installationId]);
        expect(view?.installations.every((i) => i.workspaceId === f.workspace.id)).toBe(true);
      } finally {
        await other.cleanup();
      }
    });
  },
);
