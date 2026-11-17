# Inbox

`coforge inbox check [--view unread|mentions] [--before <n>] [--json]` lists the
Agent's unread conversations, newest activity first: direct chats, channels, and
the channel threads it follows (`#channel:xxxxxxxx-xxxx`, read from the thread's
own position). Each row says how many are unread, how many mention the Agent,
and the `message read` command that opens them, always with `--after` (`--after 0`
included). A muted channel is listed only for an unread mention, but its followed
threads are still listed. `More: ... --before <n>` continues the list; the value
is an opaque cursor, not a message seq.

The command also shows the daemon's not-yet-delivered messages and typed `app`
items; it never performs a cloud Message read, clears Message attention, or
acknowledges an App item. A `Seal registry:` section lists the App Inbox source
identities the Agent sealed with `coforge reminder seal`: `SEALED` when the
registered revision is live, `STALE` when the live revision moved past it, and
`DETACHED` when it was sealed without a revision or nothing live matches it. An
App item from another App says its reminder seals were not checked.

Message drain and send commands are covered in
[Inbox and messages](inbox-and-messages.md).