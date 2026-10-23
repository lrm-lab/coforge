import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Webhook } from "standardwebhooks";

import { isWebhookEndpoint } from "#src/features/apps/app-webhook";
import {
  AppWebhookConfigError,
  deriveWebhookSecret,
  forgetAppWebhookKey,
  previousSecretValidUntil,
  readAppWebhookConfiguration,
  rememberAppWebhookKey,
  signingSecrets,
  webhookKey,
} from "#src/server/app-notifications/webhook-secret.server";
import {
  signedWebhookRequest,
  webhookBody,
} from "#src/server/app-notifications/webhook-signing.server";
import { newAppNotificationEvent } from "#src/server/app-notifications/app-notification-event";

const KEY = "k".repeat(64);
const APP = "0198a000-0000-7000-8000-000000000001";

afterEach(forgetAppWebhookKey);

test("a secret is derived from the key, the app and the generation, and is a Standard Webhooks secret", () => {
  const first = deriveWebhookSecret(KEY, APP, 1);
  expect(first).toStartWith("whsec_");
  expect(Buffer.from(first.slice("whsec_".length), "base64")).toHaveLength(32);
  expect(deriveWebhookSecret(KEY, APP, 1)).toBe(first);
  expect(deriveWebhookSecret(KEY, APP, 2)).not.toBe(first);
  expect(deriveWebhookSecret(KEY, "0198a000-0000-7000-8000-000000000002", 1)).not.toBe(first);
  expect(deriveWebhookSecret("j".repeat(64), APP, 1)).not.toBe(first);
  expect(() => new Webhook(first)).not.toThrow();
});

test("a derived secret is HMAC-SHA256 of a labelled message, so the key's other uses never collide", () => {
  const expected = createHmac("sha256", KEY).update(`coforge-app-webhook-v1:${APP}:1`).digest();
  expect(deriveWebhookSecret(KEY, APP, 1)).toBe(`whsec_${expected.toString("base64")}`);
  const unlabelled = createHmac("sha256", KEY).update(`${APP}:1`).digest();
  expect(deriveWebhookSecret(KEY, APP, 1)).not.toBe(`whsec_${unlabelled.toString("base64")}`);
});

test("the current secret signs, and the previous one only while a rotation overlaps", () => {
  const at = new Date("2026-10-22T12:00:00Z");
  const later = new Date(at.getTime() + 3_600_000);
  const row = {
    secretGeneration: 3,
    previousSecretGeneration: 2,
    previousSecretValidUntil: later,
  };
  expect(signingSecrets(KEY, APP, row, at)).toEqual([
    deriveWebhookSecret(KEY, APP, 3),
    deriveWebhookSecret(KEY, APP, 2),
  ]);
  expect(previousSecretValidUntil(row, at)).toBe(later);
  expect(signingSecrets(KEY, APP, row, later)).toEqual([deriveWebhookSecret(KEY, APP, 3)]);
  expect(previousSecretValidUntil(row, later)).toBeNull();
  const none = {
    secretGeneration: 1,
    previousSecretGeneration: null,
    previousSecretValidUntil: null,
  };
  expect(signingSecrets(KEY, APP, none, at)).toEqual([deriveWebhookSecret(KEY, APP, 1)]);
});

test("the key is read from the environment: unset is disabled, a short one fails naming the variable", async () => {
  expect(await readAppWebhookConfiguration({})).toEqual({ status: "disabled" });
  expect(await readAppWebhookConfiguration({ COFORGE_APP_WEBHOOK_KEY: "  " })).toEqual({
    status: "disabled",
  });
  expect(await readAppWebhookConfiguration({ COFORGE_APP_WEBHOOK_KEY: KEY })).toEqual({
    status: "ready",
    key: KEY,
  });
  const failure = readAppWebhookConfiguration({ COFORGE_APP_WEBHOOK_KEY: "short" });
  await expect(failure).rejects.toBeInstanceOf(AppWebhookConfigError);
  await expect(failure).rejects.toThrow("COFORGE_APP_WEBHOOK_KEY");
  await expect(failure).rejects.not.toThrow("short");
});

test("the remembered key is what delivery reads; none remembered means none", () => {
  expect(webhookKey()).toBeUndefined();
  rememberAppWebhookKey(KEY);
  expect(webhookKey()).toBe(KEY);
});

const event = newAppNotificationEvent({
  type: "workspace.member_added",
  workspaceId: "ws-1",
  data: { userId: "user-1", role: "member" },
});

test("the body is the event with the installation and Workspace, in snake_case", () => {
  const body = JSON.parse(webhookBody(event, "inst-1"));
  expect(body).toEqual({
    type: "workspace.member_added",
    timestamp: event.timestamp,
    data: { installation_id: "inst-1", workspace_id: "ws-1", user_id: "user-1", role: "member" },
  });
});

test("a body over the Standard Webhooks limit is refused", () => {
  const big = { ...event, data: { userId: "x".repeat(21_000), role: "member" as const } };
  expect(() => webhookBody(big, "inst-1")).toThrow("20 KB");
});

/** `Webhook.verify` checks the timestamp against the real clock, so these requests are signed now. */
const now = new Date();

test("a request carries webhook-id, webhook-timestamp and a signature that verifies", () => {
  const secret = deriveWebhookSecret(KEY, APP, 1);
  const body = webhookBody(event, "inst-1");
  const { headers } = signedWebhookRequest({
    messageId: "msg_job-1",
    body,
    now,
    secrets: [secret],
  });
  expect(headers["webhook-id"]).toBe("msg_job-1");
  expect(headers["webhook-timestamp"]).toBe(String(Math.floor(now.getTime() / 1000)));
  expect(headers["content-type"]).toBe("application/json");
  new Webhook(secret).verify(body, headers);
});

test("during a rotation both secrets sign, space separated; an unrelated secret does not verify", () => {
  const current = deriveWebhookSecret(KEY, APP, 2);
  const previous = deriveWebhookSecret(KEY, APP, 1);
  const body = webhookBody(event, "inst-1");
  const { headers } = signedWebhookRequest({
    messageId: "msg_job-1",
    body,
    now,
    secrets: [current, previous],
  });
  expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
  const verifyAt = (secret: string) => new Webhook(secret).verify(body, headers);
  expect(() => verifyAt(current)).not.toThrow();
  expect(() => verifyAt(previous)).not.toThrow();
  expect(() => verifyAt(deriveWebhookSecret(KEY, APP, 3))).toThrow();
  expect(() => verifyAt(deriveWebhookSecret("j".repeat(64), APP, 2))).toThrow();
});

test("an endpoint is https only, canonical, without user info or a fragment", () => {
  expect(isWebhookEndpoint("https://hooks.acme.example/in")).toBe(true);
  expect(isWebhookEndpoint("https://hooks.acme.example:8443/in")).toBe(true);
  for (const bad of [
    "http://hooks.acme.example/in",
    "http://127.0.0.1:8080/in",
    "http://localhost/in",
    "http://[::1]/in",
    "https://user:pw@hooks.acme.example/in",
    "https://hooks.acme.example/in#x",
    "https://HOOKS.acme.example/in",
    "ftp://hooks.acme.example/in",
    "not a url",
    `https://hooks.acme.example/${"a".repeat(2000)}`,
  ]) {
    expect(isWebhookEndpoint(bad)).toBe(false);
  }
});
