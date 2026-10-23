# Installed app data

An app reads the data its Workspace approved with four read-only endpoints under its installation's
resource URI, `<issuer origin>/api/app-installations/<installation id>` (the audience of its
[installation token](installation-tokens.md)). The code is
`apps/web/src/server/app-installation-data/` (`AppInstallationApi` authenticates, `AppInstallationData`
projects) over `db/repositories/app-installation-data.repositories.server.ts` (the filtering). The
routes are `apps/web/src/routes/api.app-installations.$installationId.*.ts`. They are behind the
`app-data-permissions` flag, which token verification enforces. A rate limit applies ([below](#rate-limit)).

| `GET` | Group (scope) | Answer |
| --- | --- | --- |
| `/workspace` | `workspace` (`installation:workspace`) | `{installation_id, workspace: {id, slug, name, picture_url, created_at}}` |
| `/agents` | `agent` | `{installation_id, agents: [{id, handle, display_name, description, avatar_url, created_at}]}` |
| `/channels` | `channel` | `{installation_id, channels: [{id, name, description, created_at}]}` |
| `/computers` | `computer` | `{installation_id, computers: [{id, name, kind, computer_version, online}]}` |

Deliberate departures from Raft: the paths carry the installation id (Raft: `/api/app-installation/…`, bound only by the token), because the token's audience is the installation resource ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)); `workspace` is Raft's `server`.

Lists are ordered oldest first. `created_at` is ISO 8601 UTC. `picture_url`, `avatar_url` and
`computer_version` are `null` when there is none.

## Privacy rules

Each projection names its fields; the repository query selects only those columns.

- `workspace`: the profile. `picture_url` is the Workspace icon on the public image CDN, `null`
  when it has no icon or this deployment has no image CDN (the authenticated route the Web falls
  back to is of no use to an app).
  No members, roles or emails.
- `agents`: public Agents only. A private Agent, a deleted (archived) Agent and a platform-owned
  Agent (`systemKind` set: the per-member assistants) are left out. The Workspace Memory Agent is an
  ordinary public Agent and is listed. `handle` is the Agent's unique `name` (what `@` mentions).
  `avatar_url` is the Agent's platform mascot (the one its creator picked, else the one its id
  chooses) as an absolute URL on the issuer's origin; an Agent has no uploaded picture.
  No owner, role, runtime configuration, Computer, messages or Activity.
- `channels`: the Workspace's public channels. Direct conversations, archived channels and a channel
  hidden from the Workspace are left out. No members, messages or counts.
- `computers`: Computers linked to the Workspace and not deleted. `name` is the display name, else the
  host name, else `Computer`. `kind` is `local` or `cloud`. `online` is the Computer status cache's
  lease (offline when it has none). Never the machine id, owner, platform or OS version.

## Errors

The token goes in `Authorization: Bearer` only (RFC 6750 §2.1); a query or form token is not read.
Every answer, errors included, is JSON with `Cache-Control: no-store`. Refusals follow RFC 6750 §3,
with `WWW-Authenticate: Bearer realm="<issuer>"` plus:

| Status | `error` | When |
| --- | --- | --- |
| 401 | none (bare challenge, empty body) | No `Authorization` header, or a scheme other than `Bearer` |
| 400 | `invalid_request` | A `Bearer` header that is not a single token |
| 401 | `invalid_token` | The token does not verify for the installation in the path; an installation id that is malformed, unknown or another token's is this too (never 404, so an id reveals nothing); the installation is gone or the flag is off |
| 403 | `insufficient_scope`, `scope="installation:<group>"` | The token lacks the endpoint's group, or its approval narrowed since it was issued |

A token is checked whole: once any group it carries is no longer approved, every endpoint refuses it,
including those whose group is still approved. The app mints a new token for the groups it still has.

404 `not_found` only where this deployment runs no authorization server.

## Rate limit

Each installation may make 120 reads a minute across the four endpoints (`APP_INSTALLATION_LIMIT_PER_MINUTE`). A request counts once its
token verifies, so a flood of bad or missing tokens cannot spend an installation's budget. Past the
limit the answer is 429 `{"error":"rate_limited"}` with `Retry-After` (seconds until the window
ends) and `Cache-Control: no-store`. The mechanism, window and failure mode are
[installation tokens: rate limit](installation-tokens.md#rate-limit).
