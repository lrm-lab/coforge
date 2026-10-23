import { Webhook } from "standardwebhooks";

import type { AppNotificationEvent } from "./app-notification-event";

/** Standard Webhooks asks for payloads under 20 KB; the bound is on the encoded body. */
export const WEBHOOK_BODY_MAX_BYTES = 20_000;

const snakeCase = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The JSON body of one delivery: `{ type, timestamp, data }`, where `timestamp` is when the event
 * happened and `data` names the installation and the Workspace, then the event's own data. Keys on
 * the wire are snake_case, like the installation read APIs; the event's camelCase fields convert.
 */
export function webhookBody(event: AppNotificationEvent, installationId: string): string {
  const body = JSON.stringify({
    type: event.type,
    timestamp: event.timestamp,
    data: {
      installation_id: installationId,
      workspace_id: event.workspaceId,
      ...Object.fromEntries(Object.entries(event.data).map(([k, v]) => [snakeCase(k), v])),
    },
  });
  if (Buffer.byteLength(body) > WEBHOOK_BODY_MAX_BYTES) {
    throw new Error("webhook body exceeds 20 KB");
  }
  return body;
}

/**
 * The headers of a delivery (Standard Webhooks): `webhook-id` names the message and is the same
 * on every retry, `webhook-timestamp` is when this attempt was signed (receivers reject a
 * timestamp more than five minutes off), and `webhook-signature` holds one `v1,` signature per
 * secret, space separated: the current secret first, and the previous one while a rotation
 * overlaps, so a receiver holding either verifies.
 */
export function signedWebhookRequest(input: {
  messageId: string;
  body: string;
  now: Date;
  secrets: readonly string[];
}): { headers: Record<string, string> } {
  const signatures = input.secrets.map((secret) =>
    new Webhook(secret).sign(input.messageId, input.now, input.body),
  );
  return {
    headers: {
      "content-type": "application/json",
      "webhook-id": input.messageId,
      "webhook-timestamp": String(Math.floor(input.now.getTime() / 1000)),
      "webhook-signature": signatures.join(" "),
    },
  };
}
