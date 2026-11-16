# Chat sidebar lists (web)

How the sidebar's channel and DM lists are stored, kept live, re-read and written. These rules apply to `src/features/conversations/` with the rest of [AGENTS.md](AGENTS.md).

- The sidebar's channel and DM lists live in `sidebar-collections.ts` (collections and changes, tested without React) and `sidebar-lists.ts` (hooks). The chat layout's (`_chat`) loader fetches
  them, in the browser, into the TanStack Query cache (a later page load restores the browser's copy first, `../cache-persistence/`); the same keys back TanStack DB
  collections. Every channel's name (`channelNamesQuery`, for body channel links
  and the `#` list) lives in the same cache.
- Realtime keeps every Chat list live, so the loader (run on each navigation inside Chat) reads
  only a list not cached or marked stale (`loadSidebarLists`); a subscribe that may have missed
  something re-reads that channel's lists (`rereadMissedBySubscribe`). Every list is read with the
  stream positions of the signal channels that keep it live, read before it
  (`readAfterStreamPositions`), and its Query data keeps them beside its rows
  (`streamPositions`; `listReadPosition` finds them), so a first subscribe re-reads a list only when
  the stream has moved past its read. A list built from two reads (the DM list) keeps the older
  position per channel (`olderStreamPositions`); a read that fell back has none. The Saved
  list's stored copy is cut to its newest entries, so it keeps none. A write that changes a list
  on this page re-reads it itself and keeps the positions. A read moves only the live badge,
  never a row, so a re-seed takes server counts only from a list read again (`unreadIdsToKeep`).
  Server and list share one order (`compareChannelNames`).
- A channel created, changed or gone in the Workspace (`channel.created.v1`, `channel.updated.v1`) carries its info or `gone`, which
  `applyChannelSignalToLists` (`sidebar-signals.ts`) writes into the names and the list without a read; it re-reads only
  what an event cannot place, and a list being read or while a sidebar change is saving (a failed
  save's rollback undoes a direct write made meanwhile).
- Read the lists with `useSidebarLists`, write them only through `useSidebarActions` (optimistic: a saved change is written into the synced list, a failed save rolls back; a section update, reorder or move whose save failed on the way is retried first, `SAVE_RETRY_DELAYS_MS`, never a create or remove), and never call `router.invalidate` for a sidebar change. After a signal, re-read only the list that can have changed: a message that brings a closed or unlisted chat in re-reads its own list (`closedConversationLists`) plus the Agent roster for a new Agent (`unknownAgentOf`); a top-level message in a listed DM or channel re-reads that list so the row's last message and preview stay current, whoever wrote it (`directRowRefreshLists`, `channelRowRefreshLists`); a change made outside the sidebar on this page (a channel's creation, rename or archive, or leaving, muting or pinning from the settings panel) goes through `useRefreshSidebarChannels`. The viewer's own changes elsewhere arrive as a `ViewerEvent` on their `chat:user:` channel (`channel_marked`, `channel_joined`, `im_marked`, `im_created`, `pref_change`, `star_added`, `star_removed`): a read sets the badge from the event's count; any other re-reads only the lists `sidebarListsChangedBy` names. A message signal names the person who wrote it (`senderUserId`); the viewer's own message never bumps their badge or brings a closed chat back.
