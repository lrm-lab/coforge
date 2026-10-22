# Installation tokens

An app reads the data its Workspace approved with a short-lived installation token
([app data permissions](../database-schema/apps.md#data-permissions)). It gets one from the token
endpoint with the OAuth `client_credentials` grant (RFC 6749 §4.4), naming the installation as the
resource (RFC 8707 §2). The code is `apps/web/src/server/authorization-server/installation-tokens.server.ts`
and `issued-tokens.server.ts`; the token endpoint only maps its refusals to errors. The grant is
behind the `app-data-permissions` flag ([feature flags](../feature-flags.md)), evaluated for the
installation's Workspace.

## Requesting a token

`POST /oidc/token`, a form, with the app's own client authentication (`client_secret_basic` or
`client_secret_post`) and:

| Parameter | Value |
| --- | --- |
| `grant_type` | `client_credentials` |
| `resource` | Required, once: `<issuer origin>/api/app-installations/<installation id>`, byte for byte |
| `scope` | Optional, space-separated, any of `installation:workspace`, `installation:agent`, `installation:channel`, `installation:computer`; omitted or empty asks for no group |

Answer 200 `{access_token, token_type: "Bearer", expires_in: 600, scope}`, with `no-store` headers
and no refresh token (§4.4.3). `scope` is the granted groups. Checks, in this order after client
authentication (`invalid_client`, 401, as for a code):

| Refusal (400) | When |
| --- | --- |
| `invalid_target` | `resource` missing (RFC 8707 §2 leaves a missing resource to the server; this one requires it), not an installation URI under the issuer's origin, naming no installation, or an installation of another app (answered like a missing one) |
| `unauthorized_client` | The flag is off for the installation's Workspace: RFC 6749 §5.2 says the client may not use this grant type, which is true there. The grant is not per-Workspace, so discovery advertises it regardless |
| `invalid_scope` | A scope that is not one of the four, or a group outside the installation's effective groups: approved and still declared; a declared group waiting for approval is outside them |

A form that repeats a parameter (two `resource` values included) is `invalid_request`. Every issue
and refusal logs one JSON line, `authorization_server:installation_token_issued` or
`authorization_server:installation_token_refused`, with `app_key`, `installation_id`, `groups`
and `outcome`; never the token.

## The token

An RFC 9068 JWT (`typ: at+jwt`, ES256, the first signing key, `kid`) valid ten minutes.

| Claim | Value |
| --- | --- |
| `iss` | The issuer |
| `aud` | The `resource` URI |
| `sub`, `client_id` | The app's key |
| `type` | `installation` |
| `installation_id`, `workspace_id` | The installation and its Workspace |
| `scope` | The granted `installation:` scopes |
| `iat`, `exp`, `jti` | Issued, `iat` + 600, a unique id |

## Verifying

`InstallationTokens.verify(token, installationId, now)` is what a read API calls with the bearer
token and the installation id of its path. It checks the signature, `iss`, `typ`, `aud` (that
installation's URI), `exp` and `type`, then reads the installation again, so the token holds only
while the facts hold. It answers `verified` with `{installationId, workspaceId, appKey, groups}` or
a refusal by RFC 6750 §3.1:

- `invalid_token` (401): the token does not verify, names another installation, the installation is
  gone (uninstalled) or belongs to another app, or the flag went off for the Workspace.
- `insufficient_scope` (403): a group of the token is no longer effective, because the approval
  narrowed or the app stopped declaring it. A read of a group the token never had is the read API's
  own check against the returned `groups`.

The four read routes call it: [installed app data](app-installation-data.md).

## Rate limit

The `client_credentials` grant allows 30 requests a minute per app (client), and each installation's
reads 120 a minute ([installed app data](app-installation-data.md#rate-limit)). The code is
`apps/web/src/server/app-rate-limits/`; the two numbers are `APP_TOKEN_LIMIT_PER_MINUTE` and
`APP_INSTALLATION_LIMIT_PER_MINUTE` in its composition file, changed together with this page.

- **What counts.** A `client_credentials` request counts after client authentication succeeds
  (including requests that then fail with `invalid_target` or `invalid_scope`); the
  `authorization_code` grant is not limited. A read counts after its token verifies. Nothing
  unauthenticated counts, so a flood cannot exhaust an app's budget; and nothing limits that flood
  either: Caddy applies no rate limit today, so a stream of bad secrets or tokens still costs a
  client lookup or a signature check per request.
- **Over the limit.** 429 with `Retry-After` (seconds), `Cache-Control: no-store`, and
  `{"error":"rate_limited","error_description":...}`. OAuth has no error code for it, so
  `rate_limited` is this server's, as RFC 6585 §4 allows.
- **Mechanism.** A fixed-window counter in Redis (`INCR`, `PEXPIRE` on the first request, one
  atomic `EVAL`) under `coforge:ratelimit:app-token:v1:<client id>` and
  `coforge:ratelimit:app-installation:v1:<installation id>`. The window starts at an id's first
  request, so a burst across a boundary can reach twice the limit. `rate-limiter-flexible` 11.2.3
  was not adopted: its Redis store needs an ioredis- or node-redis-shaped client, and Bun's
  `RedisClient` has no `multi()` and a different `eval`, so it would need a shim as long as the
  counter.
- **Redis unavailable.** The request is admitted (fail open: a counter outage must not take the
  apps' endpoints down, and a reply that is not the script's two numbers counts as an outage) and
  one JSON line, `app_rate_limit:redis_unavailable`, is logged at most once a minute across both
  limits. When `REDIS_URL` is unset nothing is limited and the same line is logged once, at the
  first request.
