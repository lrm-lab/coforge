import { isCanonicalHttpsUrl } from "./app-registration";

/**
 * An app's signed webhook, the HTTP delivery of app notifications: the endpoint it declares and
 * the refusals and statuses the editor shows. Pure and client-safe; `server/app-notifications/`
 * enforces it ([docs](../../../../../docs/app-notifications/http-delivery.md)).
 */

/** The longest endpoint URL. */
export const WEBHOOK_ENDPOINT_MAX_LENGTH = 2000;

/** Whether `value` is an endpoint an app may declare: https only (loopback http is not accepted,
 * unlike a redirect URI), canonical, no user info or fragment, within
 * `WEBHOOK_ENDPOINT_MAX_LENGTH`. The default port and an explicit one are both accepted. Whether
 * its host resolves to a public address is settled by the egress, at save and at every delivery. */
export const isWebhookEndpoint = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= WEBHOOK_ENDPOINT_MAX_LENGTH &&
  !value.includes("#") &&
  isCanonicalHttpsUrl(value);

/** The `errorId`s of a refused webhook change. */
export const APP_WEBHOOK_ENDPOINT_INVALID = "app-webhook-endpoint-invalid";
/** The endpoint's host does not resolve, or resolves to a non-public address. */
export const APP_WEBHOOK_ENDPOINT_UNREACHABLE = "app-webhook-endpoint-not-public";
/** `COFORGE_APP_WEBHOOK_KEY` is not configured on this deployment, so no secret can be derived. */
export const APP_WEBHOOK_UNAVAILABLE = "app-webhook-unavailable";
/** The `errorId` of the refusal for a Workspace where `app-notifications` is off. */
export const APP_NOTIFICATIONS_OFF = "app-notifications-off";

/** Why deliveries to one installation stopped (`disabledReason`): the endpoint answered `410 Gone`
 * (`endpoint_rejected`), every retry of a delivery failed (`retries_exhausted`), an event's body
 * exceeded the size limit (`payload_too_large`), or the stored endpoint is no longer one the rules
 * accept (`endpoint_invalid`). Saving the endpoint again, or rotating the secret, starts deliveries
 * again. */
export const WEBHOOK_DISABLED_REASONS = [
  "endpoint_rejected",
  "retries_exhausted",
  "payload_too_large",
  "endpoint_invalid",
] as const;
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];

/** How long the previous secret keeps signing after a rotation. */
export const WEBHOOK_SECRET_OVERLAP_HOURS = 24;
