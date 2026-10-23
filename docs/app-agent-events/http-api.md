# Agent inbound HTTP API

Part of [App events for an Agent](README.md). Behind the `app-agent-events` flag. Bodies and
errors are snake_case, like the other endpoints an app calls. Raft's equivalents are in the third
column.

| Endpoint | Credentials | Raft |
| --- | --- | --- |
| `POST /api/app-agent-requests` | `client_secret_basic` | `POST /api/oauth/requests/agent` |
| `GET /api/app-agent-requests/<id>` | `client_secret_basic` | (none: Raft returns the status in the request) |
| `POST /oidc/token`, `grant_type=urn:coforge:params:oauth:grant-type:agent_request` | `client_secret_basic` or `_post` | `POST /api/oauth/token` |
| `POST /api/app-agent-events` | `Bearer` Agent inbound token | `POST /api/oauth/agent-events` |

## Ask to send

```http
POST /api/app-agent-requests
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{ "workspace_slug": "acme", "agent_name": "research-assistant", "scopes": ["agent:event:write"] }
```

`agent_id` may replace `agent_name` and wins when both are sent. Answer 200:

```json
{
  "request_id": "5f493a7a-3f3a-4cde-b595-75d8b6591e17",
  "status": "approved",
  "scopes": ["agent:event:write"],
  "agent": { "id": "...", "name": "research-assistant", "display_name": "Research Assistant",
    "workspace_id": "...", "workspace_slug": "acme" },
  "resource": "https://coforge.example/api/workspaces/<workspace id>/agent-inbound"
}
```

`status` is `approved`, `pending` (a person must decide; poll `GET` the request) or, on the
`GET`, `denied`, `exchanged` or `expired` (a request lives 24 hours). Asking again while one waits widens that request. 404 `not_found`: no
such Workspace, Agent (live, not a platform assistant) or installation of this app, or the flag is off,
answered alike. 400 `invalid_scope`: a scope the app did not declare or that is not an Agent inbound
scope. 400 `invalid_request`: a malformed body. 401 `invalid_client`. 429 `rate_limited`.

## Exchange

`POST /oidc/token` as a form, with client authentication, `grant_type`
`urn:coforge:params:oauth:grant-type:agent_request`, `request_id` and `resource` (the `resource` of the
answer above, exactly). Answer 200 `{access_token, token_type: "Bearer", expires_in: 600, scope,
resource}`. Refusals (400): `invalid_request` (no `request_id`), `invalid_target` (no `resource`, or it
is not the request's Workspace), `invalid_grant` (unknown or another app's request, or
`request_already_consumed`), `authorization_pending` (still waiting), `access_denied` (denied),
`invalid_scope` (the app no longer declares or holds the scopes), `unauthorized_client` (flag off).

## Send

```http
POST /api/app-agent-events
Authorization: Bearer <token>
Content-Type: application/json

{ "kind": "event", "summary": "Weekly sync has started", "external_event_id": "meeting-2026-07-17",
  "ttl_seconds": 3600, "payload": { "join_url": "https://meet.example.com/weekly-sync" } }
```

| Field | Contract |
| --- | --- |
| `kind` | Required: `event` (needs `agent:event:write`) or `notification` (`agent:notification:write`). `action_request` is reserved and refused |
| `summary` | Required, at most 500 characters after whitespace is normalised |
| `payload` | A JSON object, default `{}`, at most 32 KiB |
| `external_event_id` | At most 200 characters; unique per app and Agent: a retry returns the first event |
| `ttl_seconds` | Positive, default 86400, at most 604800 |
| `agent_id` | Optional; if present it must be the token's Agent |

202 `{event_id, status: "queued", deduped: false}`; a repeated `external_event_id` answers 200 with
`deduped: true` and the first `event_id`. Errors: 401 `invalid_token` (or the bare challenge without a
token), 403 `insufficient_scope` (the kind's scope, named in `WWW-Authenticate`), 403 `access_denied`
("token cannot target a different agent"), 400 `invalid_request` (the first wrong field), 413
`payload_too_large` (also when the escaped Message would exceed 8,000 characters), 429 `rate_limited`.
