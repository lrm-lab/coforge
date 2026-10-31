# Channel read access

Moved out of [`AGENTS.md`](AGENTS.md) to keep it under 200 lines.

- A Workspace owner or admin can hide `#general` from the whole Workspace
  (`Conversation.hiddenFromWorkspaceAt`) and restore it. While hidden it is gone
  for everyone, themselves included: every channel read filters through
  `VISIBLE_CONVERSATION_WHERE` (raw SQL: `"hiddenFromWorkspaceAt" IS NULL`), so a
  new channel read must too. Enrollment keeps running, so a restore is whole.
- A private channel (`Conversation.visibility`, task #302) is read only by its
  active members; a Workspace role grants nothing. The rule is
  `channel-read-access.server.ts`, in four forms held to one answer by
  `channel-read-access.integration.test.ts`: `visibleChannelWhere(workspaceId, reader)`
  for a query (the channels the reader may read: not a DM, not hidden, public or
  the reader is an active member), `readableChannelSql(alias, workspaceId, reader)`
  for raw SQL, `canReadChannel` for a channel already read, and `channelByIdWhere`
  with `requireReadableChannel` for one channel by id on a hot path (a public
  channel costs no member probe). A channel read takes one of them, never its own
  version; there is no reader-less channel filter.
- `readableConversationWhere` is the same for a person acting on a message in a
  channel or DM (save, react, download a file). `channel-actor.server.ts` holds
  `ChannelActor` and `channelActorMemberWhere`, which the rule and the roster share.
- `personConversationAccess` answers one conversation by id for a gate with
  nothing else (a realtime subscription, a file download): a DM they are in, or
  a channel `canReadChannel` lets them read. Realtime follows the rule too: a
  private channel's `channel.created.v1`, `channel.updated.v1` and Task changes
  go to its active people's own channels (`channelAudience`,
  `conversationSignalScopes`), never the Workspace channel, as an Agent's live
  Activity there does (`cachedActivityAudience`), and leaving it ends
  the leaver's subscriptions to it (`announceConversationsRevoked` (`channel-membership-signals.server.ts`)).
- A person who cannot read a channel gets the `NOT_FOUND` a missing one gets, and
  reading comes before authority: `viewerChannel`, `memberChannel` and
  `findChannelById` read through the rule, so an owner or admin outside a private
  channel cannot join, update, archive, delete or list it, nor add or remove its
  members. A write that names a channel by membership alone (pins, chat sections)
  answers a missing channel and a private one alike.
- Surfaces beyond the channel's own pages keep to the rule as well: a project
  lists and counts only the channels the viewer reads (`projectDetailSelect`,
  `projectListSelect`), a forward to a private channel the forwarder is not in fails
  as `no_access`, an action card neither names nor links it and acts on it only for
  an active member, an Agent's reminder anchored in it links nowhere, an Agent's
  Activity there shows only to its members (`unreadableConversationIds`), and no App event
  names it (`recordAppNotifications`, as an App lists public channels only).
  Workspace memory learns only from public channels (`MEMORY_SOURCE_CHANNEL_WHERE`),
  since what it learns is offered to everyone. Turning a channel private looks
  forward, not back: what memory learned while it was public stays, as messages
  people already read do. A
  task's own conversation is never read as a notification by id: its board decides
  who reads it, not the seats it keeps.
- A write that changes who is in a channel or whether it is private calls
  `channelPeopleChanged` once it commits: the live Activity audience remembers both
  per process and forgets them only on that signal (or its 30 s backstop).
- A channel is created private by a person, an Agent or an action card alike;
  the Workspace memory Agent joins only a public one. Only a Workspace owner or
  admin who is an active member turns a channel private or public, never a
  channel admin as such, never `#general` or an archived channel
  (`setChannelVisibility`, `channel-visibility-change.server.ts`). Turned private,
  everyone outside it loses it at once: their subscriptions end, their lists drop
  it (`gone`) and the live Activity audience forgets it. Turned public, every list
  gains it (`channel.created.v1`) and apps are told it was created. Every other
  read applies the rule when it runs.
