---
title: App Bot
description: Give your App its own identity in a Workspace - declare a bot, have an owner or admin enable it, mint its key, and read and send messages as the App.
---

# App Bot

> **Experimental.** The Settings controls are shown only where the `app-bot` flag is on for the
> Workspace. The calls below work for any App whose bot a Workspace owner or admin has enabled.

An App Bot is your App's own identity inside a Workspace: an Agent that CoForge creates and manages
for your App. People can message it, @-mention it and add it to channels, and it sends messages as
your App with a **Bot** badge. It takes no seat, runs nothing by itself and has no presence: it acts
only when your backend calls.

## Three steps

Enabling a bot is not one switch. Three actors each do one thing, and none implies the others.

| Step       | Who                                                            | What                                                                                                     |
| ---------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1. Declare | You, the App's developer                                       | Turn on **Enable bot** in the App's editor. Nothing is created yet.                                      |
| 2. Enable  | An owner or admin of each Workspace where the App is installed | Press **Enable bot** on the installation. Signing in with CoForge and other approvals do not include it. |
| 3. Call    | Your App's backend, with its client credentials                | Mint the bot's key and call the Agent API.                                                               |

Turning the declaration off later revokes every Workspace's grant and disables the bots at once. A
Workspace owner or admin can also press **Disable bot**; enabling it again brings back the same
identity, and the messages it already sent keep their sender.

Enabling creates the bot the first time. Its handle is your App's key (the client ID) and its name is
your App's name, so **choose the key you want as the bot's handle when you register the App**. If an
Agent or a member already uses that handle, enabling is refused and nothing is renamed.

## Mint the bot's key

Your backend sends the App's client credentials (HTTP Basic, the App's key and secret). `:id` is the
installation ID shown in the App's detail.

```http
POST /api/app-installations/:id/bot-token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{ "rotate": false }
```

```json
{
  "credentialId": "...",
  "apiKey": "sk_agent_...",
  "agentId": "...",
  "scopes": ["send", "read", "mentions", "channels"]
}
```

- The key is shown once and stored only as a hash. Keep it in your backend's secret store.
- It does not expire. It ends when the bot is disabled, the declaration is turned off, or you rotate.
- A bot has one live key. A second call without `rotate` is `409 credential_exists`; `rotate: true`
  replaces the key in one step.
- A person's or Agent's token cannot mint a key: only the App's client credentials can.
- Errors: `403 bot_not_granted` (not enabled for this installation), `404 bot_not_active` (the bot
  was deleted; enable it again), `404 installation_not_found` (also for another App's installation).

## Read and send

Call the Agent API with the key alone: `Authorization: Bearer sk_agent_...`.

| Capability | Calls                                                                            |
| ---------- | -------------------------------------------------------------------------------- |
| `send`     | `POST /api/agent/v1/messages`                                                    |
| `read`     | `GET /api/agent/v1/events` (your inbox), `GET /messages`, `GET /messages/search` |
| `mentions` | `GET /api/agent/v1/messages/:id/mention-deliveries`                              |
| `channels` | `GET /api/agent/v1/channels/:channel`, `GET /api/agent/v1/users/:name`           |

Anything else (tasks, knowledge, attachments, reminders, channel management) is
`403 capability_not_granted`.

- There is no push or webhook. Poll `GET /events`: it returns the unread messages and a `cursor`
  and takes nothing. Handle the batch, then pass the cursor as `GET /events?since=<cursor>` to
  acknowledge it and get what came next. A batch you did not acknowledge comes again, so make your
  handling idempotent. Answer with `POST /messages`.
- To message a member, send to `@username`; the conversation is made by your first message.
- The bot is in no channel until a person adds it, and it cannot post to a channel it is not in.

## Publish a status line

```http
PUT /api/app-installations/:id/bot-status
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{ "text": "Indexing 2,341 packages" }
```

`text` is at most 160 characters (UTF-16 units, counted before trimming); an empty string is
`400`, and `null` clears it. It is shown on the bot's profile and hover card as text your App
published, not as presence. Disabling the bot clears it.

Contract: [App Bot](https://github.com/lrm-lab/coforge/blob/main/docs/app-bot/README.md) and its
[HTTP API](https://github.com/lrm-lab/coforge/blob/main/docs/app-bot/http-api.md).
