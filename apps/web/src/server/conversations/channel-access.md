# Channel read access

Moved out of [`AGENTS.md`](AGENTS.md) to keep it under 200 lines.

- A Workspace owner or admin can hide `#general` from the whole Workspace
  (`Conversation.hiddenFromWorkspaceAt`) and restore it. While hidden it is gone
  for everyone, themselves included: every channel read filters through
  `VISIBLE_CONVERSATION_WHERE` (raw SQL: `"hiddenFromWorkspaceAt" IS NULL`), so a
  new channel read must too. Enrollment keeps running, so a restore is whole.
- A private channel (`Conversation.visibility`, task #302) is read only by its
  active members; a Workspace role grants nothing. The rule is
  `channel-read-access.server.ts`: `readableChannelWhere` for a query,
  `canReadChannel` for a channel already read, held to the same answer by
  `channel-read-access.integration.test.ts`. A channel read takes one of them,
  never its own version.
