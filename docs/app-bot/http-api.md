# App Bot HTTP API

What the app's backend calls. Authorization and rules are in [App Bot](README.md). Code:
`apps/web/src/server/app-bots/app-bot-endpoint.server.ts` (the two routes),
`app-bot-agent-api.server.ts` and `app-bot-capabilities.server.ts` (the Agent API door).

Both routes authenticate the app with its client credentials: HTTP Basic (`client_secret_basic`,
RFC 6749 section 2.3.1) with the app's key as the username. A bearer token of any kind, a missing
or wrong secret is `401 invalid_client`. Answers are `no-store`; errors are
`{"error": "<code>", "error_description": "..."}`. `:id` is the installation id (the app reads it
from the Settings detail, or from `POST /api/app-installations/lookup` with `app-installation-setup`
on).

## Mint the key

`POST /api/app-installations/:id/bot-token`, body `{"rotate": false}` (optional; a body that is not
an object or a non-boolean `rotate` is `400 invalid_request`).

```json
{ "credentialId": "...", "apiKey": "sk_agent_...", "agentId": "...",
  "scopes": ["send", "read", "mentions", "channels"] }
```

- The key is shown once; only its SHA-256 is stored. It never expires and ends with the grant, the
  bot's archive, `enableBot` going off, or a newer key.
- A bot has at most one live key (`app_bot_credentials_one_live`). A call with one live and no
  `rotate` is `409 credential_exists`. `rotate: true` revokes the live key and mints the next in
  one transaction.

| Status | `error` | When |
| --- | --- | --- |
| 404 | `installation_not_found` | Unknown, malformed, or another app's installation (no existence leak) |
| 403 | `bot_not_granted` | Never granted, revoked, or the app stopped declaring a bot |
| 404 | `bot_not_active` | Granted, but the bot Agent was archived (grant it again) |
| 409 | `credential_exists` | A live key exists and `rotate` is not true |
| 429 | `rate_limited` | 30 requests a minute per app, shared with the token endpoint |

## Publish a status line

`PUT /api/app-installations/:id/bot-status`, body `{"text": "Indexing 2,341 packages"}`.

- `text` is at most 160 UTF-16 units counted before trimming and is stored trimmed. An empty or
  blank string, a longer one, or a non-string is `400 invalid_request`. `null`, or no `text`, clears
  it. Revoking clears it, so a new grant never shows stale text.
- Written in one conditional update that checks the grant, the Agent and `enableBot`, so a revoke
  that lands first wins and nothing is stored. Refusals: `404 installation_not_found`,
  `403 bot_not_granted`, `403 bot_not_active`. 120 requests a minute per app and installation.
- It is app-published text, shown on the bot's profile and hover card under "Managed by app". It is
  not presence; do not write heartbeats into it.

## What the key may call

`Authorization: Bearer sk_agent_...` alone (no daemon key, no `x-coforge-agent-api-key`). The key
works only on these `/api/agent/v1` calls; anything else is `403 capability_not_granted`, and a key
that does not hold is `401`.

| Capability | Calls |
| --- | --- |
| `send` | `POST /messages` |
| `read` | `GET /messages`, `GET /messages/search`, `GET /messages/:id/resolve`, `GET /events` (the inbox) |
| `mentions` | `GET /messages/:id/mention-deliveries` |
| `channels` | `GET /channels/:channel`, `GET /users/:name` |

Not carried: tasks, knowledge (`/openviking`), attachments and upload sessions, reminders, apps,
profile, workspace, action cards, and channel management (create, join, leave, members, mute,
archive, rename).

- **Receiving** is a pull, and a pull takes nothing. `GET /events?limit=` returns the unread
  messages, `hasMore`, and an opaque `cursor`; asking again returns the same messages. Hand the
  cursor back as `GET /events?since=<cursor>` after the batch is safely handled: that acknowledges
  everything up to it (the bot's read boundary moves, per conversation and thread) and answers what
  has arrived since, with a new cursor. Replaying a cursor is harmless, a handled-twice batch is the
  app's to make idempotent, and a `since` that is not a cursor from this route is `400`. Nothing is
  pushed, and adding the bot to a channel only makes its messages visible there. A message that
  @-mentions the bot is not a tracked mention delivery: nothing launches the bot, so the sender's
  mention delivery stays `pending` rather than `lost`.
- `GET /messages` reads a conversation's history and, as for any Agent, marks what it returned as
  seen, so those messages leave the inbox; poll `/events` for new work.
- Paths are matched with encoded separators refused: `/channels/a%2Fb` is not `/channels/a`.
- **Direct messages**: send to `@username` of any Workspace member; the conversation is made by the
  first message. A person may message the bot first.
- **Channels**: sending to `#channel` works only where the bot is a member; otherwise the send is
  refused as for any Agent outside the channel.
