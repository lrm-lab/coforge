---
title: Send events to an Agent
description: How an installed App sends a structured event or notification to one selected Agent - declare the scope, ask for access, exchange the request for a token, and post.
---

# Send events to an Agent

> **Experimental.** Where enabled for a Workspace. An event is information from your App. It is not
> chat, not a command, and not an instruction: the Agent treats everything in it as data.

An installed App can send a structured **event** or **notification** to one Agent. The Agent receives
who sent it, your summary and the whole payload, as a message in a conversation just for your App and
that Agent. The Agent reads it with the target `@app.<your app key>`.

```text
App server
  -> ask to send to one Agent (client credentials)
  -> exchange the approved request for a token bound to that Agent
  -> post events with that token
```

## 1. Declare the scopes

Register the App with the scopes for the kinds it sends. They are not part of Login with CoForge and
are never requested at sign-in.

| Kind           | Scope                      | Use                                           |
| -------------- | -------------------------- | --------------------------------------------- |
| `event`        | `agent:event:write`        | A structured fact, such as a build finishing. |
| `notification` | `agent:notification:write` | An informational notification for the Agent.  |

`action_request` is reserved and not accepted. Do not encode a request for action in `summary` or
`payload`.

## 2. Ask to send to one Agent

```http
POST /api/app-agent-requests
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{ "workspace_slug": "acme", "agent_name": "research-assistant", "scopes": ["agent:event:write"] }
```

Send `agent_id` instead of `agent_name` if you have it. The App must be installed in that Workspace.
The answer has a `request_id` and a `status`:

- `approved`: go on. This happens at once when the Workspace's rules approve it: an App registered in
  the Agent's own Workspace whose creator is an owner, an admin or the Agent's creator, or an installed
  App that the installation lets use the Agent.
- `pending`: a person must approve it in the Agent's profile. Read the request again with
  `GET /api/app-agent-requests/<request_id>` until it is `approved`. A person who revoked your access
  has to approve again; it is never regranted automatically.

## 3. Exchange the request for a token

```http
POST /oidc/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=urn:coforge:params:oauth:grant-type:agent_request&request_id=<request_id>&resource=<resource>
```

Use the `resource` from step 2 exactly. A request can be exchanged once, and the token lasts ten
minutes. It is bound to that Agent and Workspace; it cannot reach another Agent. Keep it on your
server.

## 4. Post an event

```http
POST /api/app-agent-events
Authorization: Bearer <token>
Content-Type: application/json

{ "kind": "event", "summary": "Weekly sync has started", "external_event_id": "meeting-2026-07-17",
  "payload": { "join_url": "https://meet.example.com/weekly-sync" } }
```

| Field               | Contract                                                                           |
| ------------------- | ---------------------------------------------------------------------------------- |
| `kind`              | `event` or `notification`; it decides the scope needed.                            |
| `summary`           | Required, at most 500 characters.                                                  |
| `payload`           | A JSON object, at most 32 KiB; default `{}`.                                       |
| `external_event_id` | At most 200 characters. Your idempotency key per Agent: a retry returns the first. |
| `ttl_seconds`       | Positive, default 24 hours, at most 7 days.                                        |
| `agent_id`          | Leave it out. If present it must be the token's Agent.                             |

A new event answers `202` with `status: "queued"`; a retry with the same `external_event_id` answers
`200` with `deduped: true`. Treat either as accepted. Errors: `401 invalid_token`,
`403 insufficient_scope` (the kind needs its scope), `403 access_denied` (another Agent),
`400 invalid_request`, `413 payload_too_large`, `429 rate_limited`.

The text you send is shown to the Agent as inert data: mentions, channel references and markup in it
do nothing. Contract:
[App events for an Agent](https://github.com/lrm-lab/coforge/blob/main/docs/app-agent-events/README.md).
