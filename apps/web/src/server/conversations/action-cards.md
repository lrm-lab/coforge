# Action cards

Moved out of [`AGENTS.md`](AGENTS.md) to keep it under 200 lines; the rules are unchanged.

- `ActionCards.prepare` resolves every handle in a `channel:create`, `agent:create`, or
  `channel:add_member` action to a UUID (`ActionCardHandles`; an `app:register` action is checked by the app registry's rules, `app-register-action-cards.server.ts`, whose commit registers the app, sets the owner Agent and settles the card in one transaction; an `app:recover_owner` action is checked by `AppOwnerAgents.prepareRecovery`, `app-recover-owner-action-cards.server.ts`, and its commit re-checks that the app still has no live owner Agent), reuses the Agent message-send target resolver and
  membership rule (`resolveActionCardTarget`), and creates the posted Message and the `ActionCard`
  row in one conversation-locked transaction (`createActionCardMessage`). The server alone posts
  `app:grant_agent` (`AppGrantCards`) once per waiting app access request, under its row lock;
  whoever decides the request settles the card in that transaction (`settleAppGrantCard`).
- `ActionCards.viewsFor(workspaceId, viewerUserId, messageIds)` (`action-card-views.server.ts`) is
  one batched lookup per message page. Never look up action cards per message.
- Every commit path runs the real operation first, under the committing human's identity and that
  operation's own authorization (`PublicChannels.create`/`addMembers`, `createAgent` with
  `assertCanCreateAgents`, `AppAgentAccess.approve`), then marks the card `executed` with a
  conditional update; a double commit fails on that operation's uniqueness rule or is a no-op.
- `ActionCards.cancel` (the preparing Agent's owner or a Workspace owner/admin) only moves `pending
  → cancelled`; it refuses `app:grant_agent`, which `AppGrantActionCards.deny` cancels after `AppAgentAccess.deny`.
- Card state changes publish the existing `ConversationRealtime.messageAvailable`; do not add a card-specific realtime channel.
- A `page:fill` card stores field labels and selectors only. Commit types the submitted values
  into that Agent's browser through the desktop proxy and marks the card executed with the field
  names. The values are not written to the card, the message, or the result.
- Agent-facing message reads append ` [action card: <state>]` to a card message's body so an Agent never claims a
  resource exists before a human commits it.
