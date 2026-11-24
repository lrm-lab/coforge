---
title: Send events to an Agent
description: How an installed App sends a structured event or notification to one selected Agent - declare the scope, ask for access, exchange the request for a token, and post.
---

# Send events to an Agent

> **Flag-gated (`app-agent-events`).** Off by default; available only when the `app-agent-events`
> flag is enabled for the Workspace (when off, the endpoints answer `404 not_found` or
> `400 unauthorized_client` and the Agent's page shows nothing). An event is information from your
> App. It is not chat, not a command, and not an instruction: the Agent treats everything in it as
> data.

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

In the App editor under **Send to Agents** (shown while `app-agent-events` is on), declare the
scopes for the kinds your App sends. They are not part of Login with CoForge and are refused at the
authorization endpoint if requested at sign-in.

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

Send `agent_id` instead of `agent_name` if you have it (`agent_id` wins if both are sent). The App
must be installed in that Workspace. The answer has a `request_id`, `status`, `scopes`, `agent` and
`resource` (rate limit: 30 requests a minute per App):

- `approved`: go on. This happens at once when an active grant already covers the scopes, or when
  the Workspace's rules approve it automatically: an App registered in the Agent's own Workspace
  whose creator is a current owner, admin or the Agent's creator (and the installation includes the
  Agent), or an App installed from another Workspace whose installation includes the Agent.
- `pending`: a person who may manage the Agent's app access (a Workspace owner, admin or the Agent's
  creator) must approve it in the Agent profile's **Apps → App events** section. Poll
  `GET /api/app-agent-requests/<request_id>` (`approved`, `pending`, `denied`, `exchanged` or
  `expired`) until it is `approved`. A person who revoked your access has to approve again; it is
  never regranted automatically.

A request expires after **24 hours** (an expired request cannot be approved or exchanged; ask
again). Errors: `400 invalid_request`, `400 invalid_scope` (undeclared or non-inbound scope),
`401 invalid_client`, `404 not_found` (unknown Workspace/Agent/installation, platform assistant or
flag off), `429 rate_limited`.

## 3. Exchange the request for a token

```http
POST /oidc/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=urn:coforge:params:oauth:grant-type:agent_request&request_id=<request_id>&resource=<resource>
```

Authenticate with `client_secret_basic` or `client_secret_post`, and use the `resource` from step 2
byte for byte. A request can be exchanged once, and the token lasts 10 minutes (`expires_in: 600`).
It is bound to that Agent and Workspace; it cannot reach another Agent. Keep it on your server.
Refusals (`400`): `invalid_request`, `invalid_target`, `invalid_grant`, `authorization_pending`,
`access_denied`, `invalid_scope`, `unauthorized_client` (flag off).

## 4. Post an event

```http
POST /api/app-agent-events
Authorization: Bearer <token>
Content-Type: application/json

{ "kind": "event", "summary": "Weekly sync has started", "external_event_id": "meeting-2026-07-17",
  "ttl_seconds": 3600, "payload": { "join_url": "https://meet.example.com/weekly-sync" } }
```

| Field               | Contract                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `kind`              | Required: `event` or `notification`; it decides the scope needed.                                     |
| `summary`           | Required, at most 500 characters (after whitespace normalization).                                    |
| `payload`           | A JSON object, at most 32 KiB; default `{}` (the escaped rendered message must also fit 8,000 chars). |
| `external_event_id` | At most 200 characters. Your idempotency key per App and Agent: a retry returns the first event.      |
| `ttl_seconds`       | Positive, default 86,400 (24 hours), at most 604,800 (7 days).                                        |
| `agent_id`          | Leave it out. If present it must be the token's Agent.                                                |

A new event answers `202` with `{ event_id, status: "queued", deduped: false }`; a retry with the
same `external_event_id` answers `200` with `deduped: true` and the first `event_id`. Treat either
as accepted. Rate limit: 120 events a minute per App and Agent. Errors: `401 invalid_token`,
`403 insufficient_scope` (the kind needs its scope), `403 access_denied` (another Agent),
`400 invalid_request`, `413 payload_too_large` (also when the escaped message exceeds 8,000
characters), `429 rate_limited`.

The text you send is shown to the Agent as inert data: mentions, channel references and markup in it
do nothing. Contracts:
[App events for an Agent](https://github.com/lrm-lab/coforge/blob/main/docs/app-agent-events/README.md)
and [HTTP API](https://github.com/lrm-lab/coforge/blob/main/docs/app-agent-events/http-api.md).
