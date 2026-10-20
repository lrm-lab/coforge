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

Staging and production do not set these variables yet, and must not until the authorization
and token endpoints exist: OpenID Connect Discovery requires `authorization_endpoint` (and
`token_endpoint` for the code flow), so until then the metadata is not conformant and strict
clients reject it.

## Endpoints

| Endpoint | Answer |
| --- | --- |
| `GET /oidc/.well-known/openid-configuration` | OpenID Connect Discovery 1.0 metadata |
| `GET /.well-known/oauth-authorization-server/oidc` | The same metadata at the RFC 8414 path for an issuer with a path |
| `GET /oidc/jwks` | The public keys, in configured order |

The metadata advertises only endpoints that exist. Its fixed policy: the `code` response
type in the query response mode, PKCE with `S256` only, ES256 ID tokens, public subject
identifiers, `client_secret_basic` and `client_secret_post` client authentication, and the
`iss` authorization response parameter (RFC 9207). It states `request_uri_parameter_supported:
false`, because Discovery defaults that field to true.

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
allowed it. `identity` is accepted and stored, but releases no claims until the Workspace claims
(`workspace_id`, `workspace_slug`, `workspace_role`) are issued under it. The tokens Agents get for
an app carry the app's client ID as their audience.
