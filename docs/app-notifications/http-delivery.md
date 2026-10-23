# App notifications: HTTP delivery

How an event reaches an app's signed webhook. Part of [app notifications](../app-notifications.md);
the secret, the signing key and the endpoint rules are in [webhook secret and
endpoint](webhook-secret.md). The code is `apps/web/src/server/app-notifications/`
(`webhook-delivery.server.ts`) over `apps/web/src/server/egress/`; tables:
[app registry, webhooks](../database-schema/apps.md#webhooks).

An app's owner or admin enables a webhook by saving an endpoint; one endpoint and one signing secret
per app, and the body carries `installation_id` to tell its installations apart. Server functions for
the editor are in `features/apps/app-webhooks.functions.ts`: `loadAppWebhook` (the endpoint, revision
and per-installation status, for the caller's own Workspace only), `saveAppWebhookEndpoint`,
`rotateAppWebhookSecret` and `disableAppWebhook`. A call that makes a secret returns it as
`signingSecret`, once.

## Request

`POST` of `{ "type", "timestamp", "data": { "installation_id", "workspace_id", ... } }`
(`Content-Type: application/json`, under 20 KB). `timestamp` is when the event happened; `data` holds
the event's fields in snake_case (`workspace.member_added`: `user_id`, `role`). Headers follow
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
signed with the official `standardwebhooks` package (1.1.1, MIT):

- `webhook-id`: `msg_` and the delivery job id (`UUIDv5(eventId:installationId)`), the same on every
  retry, so a receiver deduplicates on it (delivery is at least once).
- `webhook-timestamp`: when this attempt was signed, in seconds; receivers reject one over five
  minutes off.
- `webhook-signature`: `v1,<base64 HMAC-SHA256>` per secret, space separated.

## Who is notified

Events fan out only to installations whose app has an enabled webhook (`subscribersOf`). An event
that happens while an installation is stopped, or while the deployment has no signing key, is not
delivered later: its job completes without sending.

## Outcome of an attempt

Each attempt has a 15 s limit in all, across the addresses tried.

- 2xx: delivered; `lastDeliveryAt` is set and `consecutiveFailures` reset.
- 410: deliveries to that installation stop (`disabledReason` `endpoint_rejected`) and the job
  completes.
- An event whose body exceeds 20 KB, or a stored endpoint the rules no longer accept: deliveries
  stop at once (`payload_too_large`, `endpoint_invalid`) and the job completes, because a retry
  cannot change either.
- Anything else (other status, a redirect, a timeout, a network error, a non-public address, a
  proxy in the environment): the job throws and pg-boss retries it ([retries](../app-notifications.md#retries));
  `lastError` is a short classifier (`http_503`, `timeout`, `network`, `address_not_public`, ...),
  `nextAttemptAt` the earliest retry, and `consecutiveFailures` the failed attempts of that delivery
  so far, taken from the job's retry count so an attempt recorded twice counts once. When the last
  retry fails, deliveries to the installation stop (`retries_exhausted`) and the job completes.
- No signing key on the deployment (`COFORGE_APP_WEBHOOK_KEY` unset): the job completes unsent with
  `lastError` `key_unavailable`, logged once as `app_notifications:webhook_key_unavailable` until a
  key is present again. It is not a stop, so a configuration loss never disables every installation.
- Skipped without sending, job completed: no webhook or a disabled one, the installation is gone,
  `app-notifications` is off for its Workspace, or deliveries to it have stopped.

A stopped installation's status carries `disabledReason` and `disabledAt`; the editor shows it as
not enabled. A stopped installation's later jobs are skipped.

## Status and revisions

Saving the endpoint, rotating the secret, disabling and enabling each bump the webhook's `revision`
and clear every installation's status, which restarts stopped deliveries. A status records the
revision it was written at, and a delivery ignores one of an older revision, so a stop never
outlives the endpoint it was about. An attempt writes its status only while the revision is the one
it started with. Disabling deletes the endpoint at once and is allowed even while the flag is off or
the key unset. Neither a secret, the key nor a response body is ever logged or stored; the response
body is cancelled unread.

## Egress

Every request goes through `OutboundEgress` (`server/egress/`), shared with Web Push:

- https only; every address the host resolves to must be public (loopback, private, link-local and
  the IANA special-purpose ranges are refused), checked again at every attempt.
- The request goes to a checked address (pinned, TLS verified against the real hostname) and never
  follows a redirect. If a connection fails before any status arrives, the next checked address is
  tried, up to three, within the same 15 s.
- Bun's `fetch` reads `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY` and `all_proxy` and has no option to
  ignore them, which would bypass the pinning. The default fetch therefore refuses to send (a
  retryable `proxy_configured` failure) while one is set; a deployment must not set them on the Web
  service.
- There is no loopback or plain-http path in production code. A test supplies `resolve` and `fetch`
  to the `OutboundEgress` constructor.
