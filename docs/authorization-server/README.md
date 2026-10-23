# Login with CoForge

CoForge is an OpenID Connect authorization server for third-party apps. People still sign
in to CoForge through Authing; this server is a separate role in which CoForge itself
issues tokens to the apps a Workspace uses. It is hand-written on `jose` in
`apps/web/src/server/authorization-server/`, and it shares nothing with the device-flow
server the Computer signs in through (`/.well-known/oauth-authorization-server`,
`/oauth/*`, `/api/jwks`).

## Configuration

| Variable | Value |
| --- | --- |
| `COFORGE_OIDC_ISSUER` | The issuer, exactly `<public origin>/oidc` (the path the endpoints are served at), with no trailing slash, query, fragment or surrounding whitespace. `https` only; `http` is accepted for a loopback host in local development. Unset: the server is off and every endpoint below answers 404. |
| `COFORGE_OIDC_SIGNING_JWKS` or `COFORGE_OIDC_SIGNING_JWKS_FILE` | A private JWK Set of EC P-256 keys, each with a unique `kid`, `alg` `ES256` or none, and `use`/`key_ops`, when present, allowing signing. The first key signs; every key is published, so a key rotated to second place keeps verifying the tokens it signed. |

The issuer is a fixed value rather than one derived from the request, because apps compare
it byte for byte. The keyset is its own: never reuse the Centrifugo/Computer key
(`COFORGE_WORKER_JWT_PRIVATE_JWK`). Both are checked at boot: an unset issuer is valid, but a
set issuer that is invalid, or a missing or invalid keyset beside it, fails the boot with an
error that names the variable and never its value, so the health check never passes and a
deployment keeps its previous release. The boot log's `startup_config_checked` line reports
`authorization_server` as `configured` or `disabled`.

Production sets the issuer `https://coforge.cn/oidc` and reads the keyset from the host secret file `coforge_oidc_signing_jwks`. Staging sets neither, so its endpoints answer 404.

## Endpoints

| Endpoint | Answer |
| --- | --- |
| `GET /oidc/.well-known/openid-configuration` | OpenID Connect Discovery 1.0 metadata |
| `GET /.well-known/oauth-authorization-server/oidc` | The same metadata at the RFC 8414 path for an issuer with a path |
| `GET /oidc/jwks` | The public keys, in configured order |
| `GET /oidc/auth` | The authorization endpoint: a redirect back to the app (a code or an error), to sign-in, or the consent page; [the authorization endpoint](authorization-endpoint.md) |
| `POST /oidc/auth` | The same request sent as a form (OIDC Core §3.1.2.1): a 303 to the GET with its parameters |
| `POST /oidc/token` | The token endpoint: redeems a code once for an access token and an ID token ([the token and UserInfo endpoints](token-and-userinfo.md)); with `client_credentials`, issues an app's [installation token](installation-tokens.md); with the `agent_request` grant, an [Agent inbound token](../app-agent-events/README.md#token) |
| `GET`, `PUT /api/app-installations/<id>/setup`, `POST /api/app-installations/lookup` | An app finds its installation in a Workspace and reads and reports its setup status ([installation setup](app-installation-setup.md)) |
| `GET`, `POST /oidc/me` | The UserInfo endpoint: the signed-in person's claims for an access token |
| `POST /api/app-agent-requests`, `GET /api/app-agent-requests/<id>`, `POST /api/app-agent-events` | An app asks to send events to one Agent, and sends them with the token it exchanged ([Agent inbound](../app-agent-events/http-api.md)) |
| `POST /api/app-installations/<id>/bot-token`, `PUT /api/app-installations/<id>/bot-status` | An app's backend, with its client credentials, mints its bot's key and publishes the line shown beside the bot ([App Bot HTTP API](../app-bot/http-api.md)) |
| `GET /api/app-installations/<id>/{workspace,agents,channels,computers}` | What an installed app reads with its installation token: [installed app data](app-installation-data.md) (not under `/oidc`) |

The metadata advertises only endpoints that exist. Its fixed policy: the `code` response
type in the query response mode, the `authorization_code` and `client_credentials` grant
types, PKCE with `S256` only, ES256 ID tokens, public subject identifiers,
`client_secret_basic` and `client_secret_post` client authentication (the `agent_request` grant is not advertised: the metadata lists standard grants), and the `iss`
authorization response parameter (RFC 9207); `scopes_supported` adds the four
`installation:` scopes; `claims_supported` lists the ID token's own claims and every claim a
scope releases. It states `request_uri_parameter_supported: false`, because Discovery
defaults that field to true.

## For app developers

A Workspace's owners and admins register an app in Settings → Applications; only its name is
required (its homepage, description and redirect URIs may be left out). Registering returns
the app's client ID (its key: the one given, or one made from its name) and its client secret,
which is shown once; a lost secret is replaced by regenerating it, which stops the old one at once.

An app finds this server from the issuer, `<public origin>/oidc`, through its discovery document
at `<issuer>/.well-known/openid-configuration` (also served at
`/.well-known/oauth-authorization-server/oidc`). It authenticates with its client ID and secret
(`client_secret_basic` or `client_secret_post`) and may send people back only to the redirect URIs
it registered, compared as exact strings. Redirect URIs are optional: an app whose Agents only get
tokens registers none, so no authorization request for it can name a redirect URI it accepts.

Every app may ask for `openid`, `profile` and `identity`, and for `email` when the Workspace
allowed it. An app may also declare `agent:event:write` and `agent:notification:write`; they are
never requested here, and the authorization endpoint refuses them ([Agent inbound](../app-agent-events/README.md#scopes)). The code flow needs PKCE (`S256`). A code lives ten minutes and is redeemed once at
`<issuer>/token`, which answers an access token and an ID token, each valid for an hour, and no
refresh token. The ID token carries only who signed in (`sub`, the person's CoForge user id) and
when (`auth_time`, `nonce`, `at_hash`); the profile comes from UserInfo at `<issuer>/me` with the
access token: `sub` and, per scope: `profile` — `name`, `preferred_username`, `picture`;
`email` — `email`, `email_verified` (always false); `identity` — `type: "user"`, `workspace_id`,
`workspace_slug`, `workspace_role`. UserInfo reads them fresh, releases only the scopes the app may
still ask for and the consent still covers, and refuses the token once the person
left the Workspace, the consent was revoked, the app uninstalled, or the code was presented twice.
The access token's audience is `<issuer>/me`; the tokens Agents get for an app carry the app's
client ID as their audience ([Agent tokens](#agent-tokens)).

An app tells the two apart by `type`: a person's identity comes from UserInfo (`type: "user"` with
the `identity` scope), while an Agent's token carries `type: "agent"` itself, with the Agent's id as
`sub`. An Agent token is not accepted at UserInfo; the app reads it, after verifying it, as below.

## Agent tokens

An Agent calls one of its Workspace's apps with a token it gets from `coforge app token`
([Agent Apps](../agent-cli/apps.md)), over the Agent HTTPS API
(`POST /api/agent/v1/apps/{key}/token`), never from the endpoints above. It needs the app installed
in its Workspace and a grant ([Agents' app access](../database-schema/app-agent-access.md)): the
first use grants it automatically; after a person revoked it, a person's approval does, through an
approval card. Without an issuer configured, no Agent token is issued.

The token is an RFC 9068 JWT access token signed with the issuer's current key (`ES256`, header
`typ: at+jwt`, `kid`), valid five minutes, with no refresh: the Agent asks again at each use.

| Claim | Value |
| --- | --- |
| `iss` | The issuer |
| `aud`, `client_id` | The app's client ID (its key) |
| `sub` | The Agent's id |
| `type` | `agent` |
| `workspace_id`, `workspace_slug` | The Agent's Workspace |
| `scope` | The scopes asked for plus the fixed ones, or without a request the grant's scopes the app still allows, space-separated |
| `iat`, `exp`, `jti` | Issued, expiry (`iat` + 300), and a unique id |

An app verifies it like any RFC 9068 token: the signature against `<issuer>/jwks` by `kid`, `typ`
`at+jwt`, `iss` the issuer, `aud` its own client ID, and `exp`.
