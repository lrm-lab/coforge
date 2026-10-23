# Agent inbound (app events for an Agent)

What an installed app may send to one Agent ([model](../app-agent-events/README.md)). Migration
`20261024150000_app_agent_events`. `apps/web/src/server/app-agent-events/` owns when an app may send;
the repositories (`app-agent-inbound`, `app-agent-event`) persist only.

## `app_agent_inbound_grants`

One row per (`appId`, `agentId`) (unique): an app's standing authority to send to the Agent. `scopes` is
a non-empty subset of `agent:event:write` and `agent:notification:write`
(`app_agent_inbound_grants_scopes_check`); `source` is `automatic` or `approval`
(`app_agent_inbound_grants_source_check`); `grantedByUserId` is the approving person (null for
`automatic`). A person's revoke sets `revokedAt` and `revokedByUserId` and the row stays, so the
automatic rule never regrants: only a person's approval does, which clears the revoke. Cascades with
the app, the Agent and the Workspace.

## `app_agent_inbound_requests`

The app's request and the one-time handle it exchanges for a token: `scopes` (same check), `status`
`pending`, `approved` or `denied` (`app_agent_inbound_requests_status_check`), `decidedAt` and
`decidedByUserId`, and `exchangedAt`, set by the one conditional update that issues the token. At most
one is pending per app and Agent (partial unique `app_agent_inbound_requests_one_pending`).

## `app_agent_events`

An accepted event, written in the same transaction as its Message and delivery: `kind` `event` or
`notification` (`app_agent_events_kind_check`), `summary`, `payload` (JSONB, at most 32 KiB), `payloadHash`
(SHA-256 of the canonical payload), `externalEventId` (unique per `appId` and `agentId`, so an app's retry
finds the first event; null ids are unrestricted), `expiresAt`, the dedicated `conversationId`, and the
Message (`messageId`, unique, cascades). That conversation is a `conversations` row of `kind` `app_events` (`conversations_kind_check`) with `directKey`
`app:<appId>|agent:<agentId>` and the Agent as its only `conversation_members` row. The event's delivery carries the same `expiresAt` in `agent_message_deliveries.expiresAt`.

## Removal

Removing an installation (`removeAppInstallations`) revokes the grants and denies the pending
requests of the app in that Workspace (`revokeAppAgentInbound`). Events and their Messages stay.
