# App notifications: webhook secret and endpoint

The signing secret, the key it comes from and the endpoint rules of an app's webhook. Part of
[app notifications](../app-notifications.md); delivery is in [HTTP delivery](http-delivery.md).

## Signing secret

`whsec_` and the base64 of HMAC-SHA256(`COFORGE_APP_WEBHOOK_KEY`,
`coforge-app-webhook-v1:<appId>:<generation>`), 32 bytes (`deriveWebhookSecret`). The label keeps
this use of the key apart from any other. It is derived, never stored, and returned in plaintext
exactly once (`signingSecret`), by the call that made it: the first save that enables the webhook, a
rotation, or enabling again after a disable (a new generation, so an old secret is never valid
again). Rotation moves to the next generation; the previous one keeps signing for 24 hours, so both
signatures are sent during the overlap and a receiver holding either verifies. Rotating again inside
the overlap drops the older one. The overlap rule is in `webhook-secret.server.ts`
(`signingSecrets`).

## Signing key

`COFORGE_APP_WEBHOOK_KEY` (or `_FILE`), at least 32 characters, is read at boot
(`startup-config.server.ts`). Generate it as 32 random bytes in base64, for example
`openssl rand -base64 32`. Unset: webhooks are off on the deployment, saving and rotating are
refused (`TEMPORARILY_UNAVAILABLE`, `app-webhook-unavailable`) and deliveries are skipped
(`key_unavailable`). Set but shorter: the boot fails naming the variable.

### Rotating `COFORGE_APP_WEBHOOK_KEY`

Changing the key invalidates every secret handed out: all derived secrets change at once, and there
is no dual-key support yet. Every receiver must fetch its new secret by rotating (a rotation returns
the secret derived from the new key), and deliveries signed with the new key fail verification at a
receiver still holding the old secret until it does. Do not change the key unless it leaked.

## Endpoint rules

https only, canonical, no user info or fragment, at most 2000 characters (`isWebhookEndpoint`).
Loopback `http://` is not accepted, unlike an OAuth redirect URI. The default port and any explicit
port are both accepted. Every address its host resolves to must be public (`server/egress/`),
checked when it is saved (`app-webhook-endpoint-not-public`) and again at every delivery attempt. A
refused shape is `app-webhook-endpoint-invalid`.
