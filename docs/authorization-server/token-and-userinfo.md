# The token and UserInfo endpoints

An app redeems the code `/oidc/auth` gave it at `/oidc/token` (RFC 6749 §4.1.3–4.1.4, RFC 7636 §4.6,
OIDC Core §3.1.3) and reads who signed in at `/oidc/me` (OIDC Core §5.3, RFC 6750). The code lives in
`apps/web/src/server/authorization-server/`: `token-endpoint.server.ts`, `userinfo-endpoint.server.ts`,
the tokens in `issued-tokens.server.ts`, and what a grant is and which claims each scope releases in
`grants.server.ts`. Both endpoints answer 404 while no issuer is configured.

## Redeeming a code

`POST /oidc/token`, an `application/x-www-form-urlencoded` body (a charset parameter is fine), each
parameter once (RFC 6749 §3.2); an empty parameter counts as absent. In this order:

| Request | Answer |
| --- | --- |
| Not a form, or a parameter given twice | 400 `invalid_request` |
| Client credentials both in the Authorization header and as `client_secret` in the form (RFC 6749 §2.3) | 400 `invalid_request` |
| No credentials, unreadable ones, an unknown app or a wrong secret; a form `client_id` naming another app than Basic | 401 `invalid_client` with `WWW-Authenticate: Basic realm="<issuer>"` |
| No `grant_type` / one other than `authorization_code` and `client_credentials` ([installation tokens](installation-tokens.md)) | 400 `invalid_request` / `unsupported_grant_type` |
| No `code` or no `redirect_uri` | 400 `invalid_request` |
| An unknown code, or another app's | 400 `invalid_grant` |
| A code already redeemed | 400 `invalid_grant`, and the code's grant ends (below) |
| An expired code, a `redirect_uri` that differs by a byte, a `code_verifier` missing, not 43–128 unreserved characters, or whose S256 is not the challenge | 400 `invalid_grant` |
| The person has since left the Workspace, the consent was revoked or the app uninstalled | 400 `invalid_grant` |

`client_secret_basic` sends `client_id:client_secret`, each form-encoded first, as HTTP Basic
(RFC 6749 §2.3.1); `client_secret_post` sends both in the form. An unknown `client_id` is refused
without a secret comparison: client ids are public, so the timing gives nothing away. Another app
presenting a code learns nothing and ends nothing, since a code is checked against the authenticated
app first. A refusal before redemption leaves the code redeemable. Redemption is one conditional
update (`consumedAt` set where it is null). Of two concurrent redemptions, or a redemption the app
retries, one wins and the other is a replay: it marks the code replayed, which also ends the
winner's token. That is deliberate (RFC 6749 §4.1.2 and §10.5, kept by RFC 9700): the server cannot
tell a retry from an attacker, so a second use of a code withdraws everything it granted.

The answer is 200 JSON `{access_token, token_type: "Bearer", expires_in: 3600, id_token, scope}` (the
granted scopes). Every answer, refusals included, carries `Cache-Control: no-store` and
`Pragma: no-cache`. No refresh token is issued; after an hour the app signs the person in again.

## The tokens

Both are ES256 JWTs signed with the first configured key, its `kid` in the header; every configured key
verifies (`/oidc/jwks`). Verification allows no clock skew: the same deployment issues and verifies
the access token.

- **Access token** (RFC 9068, `typ: at+jwt`, one hour): `iss`, `sub` (the CoForge user id), `aud` — the
  UserInfo endpoint's URL (`<issuer>/me`), the one resource that accepts it — `client_id` (the app's
  key), `iat`, `exp`, `scope`, and `jti`: the code's row id. A code yields exactly one access token, so
  the `jti` names the grant UserInfo looks up.
- **ID token** (OIDC Core §2, `typ: JWT`, one hour): `iss`, `sub`, `aud` (the app's key), `iat`, `exp`,
  `auth_time` (when the person last signed in), `nonce` when the request had one, and `at_hash`
  (§3.1.3.6) — nothing else. An access token is always issued, so the claims of the scopes below
  come only from UserInfo (§5.4).

## UserInfo

`GET` or `POST /oidc/me` with `Authorization: Bearer <access token>`; a POST may instead send
`access_token` in a form body (RFC 6750 §2.2), never both (400 `invalid_request`), and the query
parameter of §2.3 is not accepted. No token is a 401 with the bare challenge
`WWW-Authenticate: Bearer realm="<issuer>"`. A token that does not verify (signature against the
configured keys, `typ at+jwt`, `iss`, `aud`, `exp`) or whose grant has ended is 401
`error="invalid_token"`. A grant ends when its code is presented again after redemption
(RFC 6749 §4.1.2, §10.5; `replayedAt`), when the person's consent to the app in that Workspace is
revoked or deleted, when the app is uninstalled from the Workspace, or when the person leaves it.

The answer is `sub` plus the claims of the scopes the grant releases now, read from the database on
every request (`Cache-Control: no-store`): the code's scopes that the app may still ask for
(`allowedScopes`) and the person's consent still covers, so narrowing either takes effect on the next
request. The same intersection, at redemption, is the token answer's `scope`.

| Scope | Claims |
| --- | --- |
| `openid` | `sub` |
| `profile` | `name` (the name teammates see), `preferred_username` (the CoForge username), `picture` |
| `email` | `email` and `email_verified: false`, when the person has an email |
| `identity` | `type: "user"`, `workspace_id`, `workspace_slug`, `workspace_role` (owner, admin or member) |

`picture` is an absolute URL an app can fetch without a CoForge session: the image CDN's URL, or one
of the platform's own pictures on the issuer's origin. An uploaded avatar that only this deployment's
signed-in route serves is left out. `email_verified` is false because CoForge keeps the address the
sign-in provider last reported but not whether the provider verified it. `preferred_username` is the
username although no CoForge page shows a person by it: it is the stable handle apps expect there. A username changes only once, at first sign-in: a new
account's fallback `user-N` is replaced when the person confirms their name (`identity-models.md`).
Sign-in sends an unnamed person to that step before any `returnTo`, so consent normally follows it, but
the authorization endpoint does not itself require it: someone who opens it by hand while still unnamed
can consent under the fallback name, which the name step then replaces.

## Codes are the grant

A redeemed code row is its grant: the access token's `jti` is the row's id, and UserInfo reads the row
on every request. Nothing deletes code rows yet; a future sweep must keep each row for at least the
access-token lifetime (one hour) after its `consumedAt`, or live tokens stop working.

## Follow-ups

- `email_verified` stays false until sign-in records whether Authing verified the address, which
  needs a new column (a schema change, so Frank's approval first).
- Nothing revokes a consent yet. When something does, it must end the grants issued under that
  consent explicitly: re-approving clears `revokedAt`, and an unexpired token issued before the
  revocation would otherwise work again until its hour is up.
