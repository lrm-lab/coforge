# The authorization endpoint

`/oidc/auth` runs the authorization code flow (RFC 6749 §4.1, OIDC Core §3.1.2) with PKCE
(RFC 7636) and the `iss` response parameter (RFC 9207), following the OAuth security BCP
(RFC 9700). The code lives in `apps/web/src/server/authorization-server/`: request checks in
`authorization-request.server.ts`, the decisions in `authorization-endpoint.server.ts`, and the
page in `apps/web/src/features/app-authorization/`. Codes and remembered consents are the
[`oauth_authorization_codes` and `user_app_consents` tables](../database-schema/oauth.md).

## Checking a request

The app (`client_id`, a registered app's key) and `redirect_uri` come first. `redirect_uri` is
required and must equal one of the app's registered redirect URIs as an exact string. While either
is missing, unknown or unregistered, the page says so (400) and nothing redirects, so a bad request
cannot send anyone to an address the app did not register.

Every later error goes back to the redirect URI with `error`, a short `error_description`, the
request's `state` and `iss`, as a 302 that no cache keeps:

| Request | Error |
| --- | --- |
| A parameter given twice (RFC 6749 §3.1) | `invalid_request` |
| `request` / `request_uri` | `request_not_supported` / `request_uri_not_supported` |
| No `response_type` | `invalid_request` |
| A `response_type` other than `code` | `unsupported_response_type` |
| A `response_mode` other than `query` | `invalid_request` |
| A `scope` without `openid`, or with a scope the app may not request (`allowedScopes`) | `invalid_scope` |
| No `code_challenge`, a `code_challenge_method` other than `S256` (`plain` included), or a challenge that is not 43 base64url characters | `invalid_request` |
| An unknown `prompt` value, or `none` with another | `invalid_request` |
| A `max_age` that is not a non-negative integer | `invalid_request` |

An empty parameter counts as absent. `nonce` is optional and kept for the ID token. Parameters the
endpoint does not use (`ui_locales`, `login_hint`, `display`, …) are ignored.

## Signing in

Signed out, the browser goes to `/login?returnTo=<this request>` and comes back to it after
signing in; `prompt=none` answers `login_required` instead. The whole request (`/oidc/auth?…`)
must fit the 2,048 characters sign-in can return to (`MAX_RETURN_TO_LENGTH` in
`features/auth/return-to.ts`), less 256 for the note below; a longer one is `invalid_request`
before anything else happens.

`prompt=login`, and a `max_age` shorter than the time since the person last signed in, send the
person (signed in or not) to `/auth/login?prompt=login`, which asks Authing to sign them in again
(`prompt=login` and `max_age=0` upstream), and back to the same request with a note, signed with
the session secret, of when CoForge asked (`coforge_signed_in_after`, 15 minutes). On return a
sign-in after that time meets both; anything else answers `login_required` rather than asking
again, so it never loops. A note the app or anyone else wrote is ignored. With `prompt=none` both
answer `login_required`. The session keeps when the person signed in: the `auth_time` of Authing's
ID token, else the time the callback completed; a session from before that was kept counts from
when it was issued. Every code records it for the ID token's `auth_time`.

## Workspaces and consent

An app is authorized in one Workspace. The Workspaces offered are those where the person is a
member and the app is installed (today only the Workspace that registered it); with none, the page
says the app is not available to them (403) and `prompt=none` answers `access_denied`.

A remembered consent (`user_app_consents`) skips the page when there is exactly one Workspace to
offer, its unrevoked consent covers every requested scope, and `prompt` has neither `consent` nor
`select_account`. Otherwise the consent page shows the app, the Workspace picker (preselected when
there is one), the requested scopes, and Continue and Cancel; `prompt=none` answers
`interaction_required` when there is a Workspace to choose and `consent_required` otherwise.

The page carries a handle on the request it shows: the checked request, the app and the person,
signed with the session secret and good for 30 minutes. Continue and Cancel are a same-origin
server function (`decideAuthorization`; TanStack Start's `createCsrfMiddleware` in `src/start.ts`
refuses a cross-site call) that answers the request the handle binds and never reads one from the
browser. A tampered or expired handle, or one shown to someone else, shows "this sign-in has
expired" and redirects nowhere. It checks again that the app still has the redirect URI and the
scopes, and that the person's sign-in still meets `prompt=login` and `max_age` (else
`login_required`). Cancel redirects with `access_denied`. Continue checks the chosen Workspace is
still offered, records the consent (the scopes granted before and now) and the code in one
transaction, and redirects with `code`, `state` and `iss`; the same answer sent twice records one
consent and two codes. Both keep any query the registered redirect URI has.

The page has no locale prefix and renders in the visitor's locale (cookie, then Accept-Language,
then English; Paraglide `routeStrategies` in `apps/web/paraglide.config.ts`), like `/oauth/verify`.
Every answer of `/oidc/auth` — redirects, the 404 without an issuer, the 400 and 403 pages and the
consent page — carries `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`,
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`. The route's loader is the one pass
over a GET; a form POST is a 303 to the same GET.

## Codes

A code is 32 bytes from the CSPRNG, base64url (43 characters). Only its SHA-256 is stored, with the
app, the person, the Workspace, the redirect URI, the PKCE challenge, the nonce, the scopes and
`auth_time`. It expires ten minutes after it is issued. Redeeming it, once, is the token
endpoint's, which does not exist yet; no refresh tokens are issued.
