# Action cards

Moved out of [`AGENTS.md`](AGENTS.md) to keep it under 200 lines; the rules are unchanged.

- `ActionCards.prepare` resolves every handle in a `channel:create`, `agent:create`, or
  `channel:add_member` action to a UUID (`ActionCardHandles`; an `app:register` action is checked by the app registry's rules, `app-register-action-cards.server.ts`, whose commit registers the app, sets the owner Agent and settles the card in one transaction; an `app:recover_owner` action is checked by `AppOwnerAgents.prepareRecovery`, `app-recover-owner-action-cards.server.ts`, and its commit re-checks that the app still has no live owner Agent), reuses the Agent message-send target resolver and
  membership rule (`resolveActionCardTarget`), and creates the posted Message and the `ActionCard`
  row in one conversation-locked transaction (`createActionCardMessage`). The server alone posts
  `app:grant_agent` (`AppGrantCards`) once per waiting app access request, under its row lock;
  whoever decides the request settles the card in that transaction (`settleAppGrantCard`).
- A `channel:create` action's optional `project` (a name, slug or UUID; `ActionCardHandles.resolveProject`)
  is stored on the card as `suggestedProjectId` and shown on its view for the confirm dialog to
  preselect. It is a suggestion only: the commit takes the confirming human's own `projectId`, never
  the card's.
- `ActionCards.viewsFor(workspaceId, viewerUserId, messageIds)` (`action-card-views.server.ts`) is
  one batched lookup per message page. Never look up action cards per message.
- Every commit path runs the real operation first, under the committing human's identity and that
  operation's own authorization (`PublicChannels.create`/`addMembers`, `createAgent` with
  `assertCanCreateAgents`, `AppAgentAccess.approve`), then marks the card `executed` with a
  conditional update; a double commit fails on that operation's uniqueness rule or is a no-op.
- `ActionCards.cancel` (the preparing Agent's owner or a Workspace owner/admin) only moves `pending
→ cancelled`; it refuses `app:grant_agent`, which `AppGrantActionCards.deny` cancels after `AppAgentAccess.deny`.
- Card state changes publish the existing `ConversationRealtime.messageAvailable`; do not add a card-specific realtime channel.
- A `page:fill` card stores field labels, optional selectors, and the Agent's computer id only.
  Commit types the submitted values into that Agent's browser through the desktop proxy (which
  resolves by label / password type when no selector is stored) and marks the card executed with
  the field names. The values are not written to the card, the message, or the result. The card
  also offers Open desktop as a client-side fallback.
- A `desktop:takeover` card stores the Agent and computer ids so the browser can open that
  Agent's cloud desktop. Commit only marks that the person finished the step; opening the desktop
  does not go through the server.
- A `choice` card stores the prompt, options, the user id of the one person it asks (`to`,
  required from the CLI) and, unless the Agent turned it off, an `other` row that is itself an
  input. Commit records `{ optionId, label }`, or `{ optionId: "_other", label, text }` for the
  person's own answer (text capped and fenced for the Agent); only that person may commit it, and
  the Agent is woken with who answered and what they chose. A request without `to` comes from
  a Computer whose CLI predates the field (its schema strips it): the server asks the Agent's
  owner, as before, and its prepare response carries a `warning` saying the Computer should be
  upgraded (never the message body, which people see in previews). Remove that fallback when no
  supported Computer is older than the release that added `to`. A card made before `to` was
  required names nobody and can no longer be answered.
  Agent-facing reads append `[action card: executed; choice=<id>]` when that result is present, with
  ` (recommended)` after the id when it is the recommended option. A choice card's body numbers its
  options in the card's order, a recommended one first.
- Agent-facing message reads append ` [action card: <state>]` (or the choice form above) to a
  card message's body so an Agent never claims a resource exists before a human commits it.
