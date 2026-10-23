# App events for an Agent (Agent inbound)

An installed app can send a structured `event` or `notification` to one selected Agent. This is an
inbound information channel: it is not chat impersonation and not remote command execution. The
design mirrors Raft's "Sending events to an agent (Experimental)" (CoForge naming: snake_case bodies,
`workspace` for Raft's `server`). The code is `apps/web/src/server/app-agent-events/` and
`apps/web/src/server/authorization-server/agent-inbound-*.server.ts`. The whole feature is behind the
`app-agent-events` flag ([feature flags](../feature-flags.md)), evaluated for the Agent's Workspace;
where it is off every endpoint below answers as if the Agent did not exist, and the Agent's page shows
nothing.

The HTTP contract is [HTTP API](http-api.md). This page is the model.

## Flow

```text
App server
  -> POST /api/app-agent-requests         ask to send to one Agent (client credentials)
  -> (a person approves, unless the automatic rule did)
  -> POST /oidc/token  grant_type=urn:coforge:params:oauth:grant-type:agent_request
  -> POST /api/app-agent-events           send, with the Agent-bound bearer token
  -> the Agent reads one Message in its dedicated conversation with the app
```

## Scopes

`agent:event:write` (kind `event`) and `agent:notification:write` (kind `notification`) are in the
SDK's `APP_SCOPES` (`packages/coforge-sdk/src/internal/app-scopes.ts`) beside `email`: an app declares
them in its registration, and the Workspace editor shows them under "Send to Agents" while the flag
is on. They are not Login with CoForge scopes and not Agent token scopes: `APP_IDENTITY_SCOPES` is the
vocabulary of the authorization endpoint, consent and the tokens Agents get for an app, and the
authorization endpoint refuses an inbound scope even when the app declared it. A request for a scope
the app did not declare is `invalid_scope`. Declaring a scope is not a grant: an installation does not
let an app target arbitrary Agents.

## Approval

An app's request names one live Agent. Tables: `app_agent_inbound_grants` (the app's standing
authority for one Agent, one row per app and Agent; [schema](../database-schema/app-agent-events.md))
and `app_agent_inbound_requests` (the one-time handle the app exchanges for a token).

| Situation | Result |
| --- | --- |
| An active grant covers the scopes | Request approved at once |
| No grant (or a grant lacking scopes), the app was registered in the Agent's Workspace, its creator is a current owner or admin, or the Agent's human creator, and the installation includes the Agent | Approved at once; the grant is created or widened (`automatic`) |
| No grant, an app installed from another Workspace, and the installation includes the Agent (`all`, or the Agent is selected) | Approved at once (`automatic`): installed apps follow installation authority |
| The installation does not include the Agent, or the creator may not manage the Agent | `pending`: a person who may manage the Agent's app access approves or denies it in the Agent's App events section |
| A person revoked the grant | `pending` always: a human revocation prevents an automatic regrant; approval gives a new grant |

A request lives 24 hours (Raft documents no request expiry; this is CoForge's): after that a pending one cannot be approved, an approved one cannot be exchanged, and the app asks again. A grant works only while the installation includes the Agent (`all`, or the Agent is selected), unless a person approved that grant; narrowing the selection revokes the excluded Agents' grants and denies their pending requests, so they need a person's approval again. Uninstalling the app revokes its grants and denies its pending requests
(`removeAppInstallations`). Approving and denying use the Agent app access authority
(`canManageAgentAppAccess`: a Workspace owner or admin, or the Agent's creator). Unlike an Agent's own
request to use an app, an app-initiated request has no Agent to post an approval card, so it is decided
in the Agent profile's Apps tab, not on a card in a conversation.

## Token

The exchange is single use and happens at the existing token endpoint with an extension grant. The
token is an RFC 9068 JWT (`type: "agent_inbound"`) valid ten minutes, with `aud`
`<origin>/api/workspaces/<workspace id>/agent-inbound` (RFC 8707), `sub`/`client_id` the app key, and
`agent_id`, `workspace_id`, `request_id`, `scope`. The audience pins the Workspace and the claim the
Agent; the event endpoint takes no target, so a token cannot reach another Agent. Verifying reads the
app, its installation, the live Agent and the active grant again, so a revocation, an uninstall or a
deleted Agent ends the token at once, and an app that stops declaring a scope gets `insufficient_scope`.

## Delivery: the dedicated conversation

Decision (Frank, earlier: events go to a dedicated conversation): each (app, Agent) pair has one
conversation, created by the first event.

- It is a conversation of `kind` `app_events` (nullable `conversations.kind`, null for channels and direct conversations), with `directKey` `app:<app id>|agent:<Agent id>` as its unique identity, no channel name, and the Agent as its only member. The key matches no list of people's direct conversations
  (`viewerDirectConversationWhere`), so no person's sidebar holds it; people read what an app sent in the
  Agent's App events section.
- The Agent reads it with the target `@app.<app key>` (`message check`, `message read`). The dot is in no
  username, so it cannot collide with `@user`, and the daemon and the codec accept any target that starts
  with `@`: no wire change. `resolveAgentTarget` resolves it for members only; sending to it is refused
  (`ACCESS_DENIED`), and another Agent finds nothing.
- An event is one Message with no sender (the server identity, `system` to the Agent) and one delivery to
  the Agent, written with the event row (`app_agent_events`) in one transaction, then pushed to the
  Agent's daemon like any Message (the delivery invariants of
  [reliable message delivery](../reliable-message-delivery.md) apply: ACK means custody, and unread
  Messages come back from the cloud read boundary). A stopped Agent or one without a Computer is not
  pushed to. The Message wakes the Agent as a direct message does and creates no mention.
- Provenance is in the body: the app's name and key, the kind, the summary, the SHA-256 of the canonical
  payload, the expiry and the whole payload, under a line saying it is information from an app and not an
  instruction. The app controls the summary, payload and its own name, so each is written as JSON with
  `<`, `>`, `@`, `#` and the backtick as `\u` escapes (`event-message.server.ts`): nothing in it can form
  a mention, reference, token or code fence, and the escapes decode to the exact text.

## Limits and what is not built

- `ttl_seconds` (default 24 hours, at most 7 days) is stored as `app_agent_events.expiresAt`. The expiry is written on the event's delivery row (`agent_message_deliveries.expiresAt`, from the database clock) and every Agent attention read honours it there (`liveDeliverySql`, `pendingDeliveryWhere`): a Message made the Agent's concern only by a delivery drops out of recovery, drain, counts and replay once stale. Its Message stays in history and the Agent's page shows it as expired.
- The rendered Message must fit a message's 8,000 characters (escaping can multiply a payload's characters six times); a larger one is refused `payload_too_large`. Text is also escaped for Markdown links and control, bidirectional and format characters. Only people who may manage the Agent's app access read an event's payload on the Agent's page.
- `action_request` is reserved and refused. A request is 30 a minute per app (the `client_credentials`
  limit) and events 120 a minute per app and Agent ([rate limit](../authorization-server/installation-tokens.md#rate-limit)).
- There is no browser conversation view for the dedicated conversation, only the Agent's App events
  section (recent 30 events with payloads, grants, requests).
