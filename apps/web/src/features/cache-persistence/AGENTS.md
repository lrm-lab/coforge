# Browser copy of the Query cache

These rules apply to `src/features/cache-persistence/`. It is Slack's client-store boot: the Query
cache (our client store) is copied into IndexedDB, and the next page load shows Chat from that copy
while the normal reads and realtime bring it up to date
([Slack](https://slack.engineering/getting-to-slack-faster-with-incremental-boot/)). It uses
TanStack Query's per-query persister, `experimental_createQueryPersister`, not
`PersistQueryClientProvider`
([docs](https://tanstack.com/query/latest/docs/framework/react/plugins/createPersister)): each query
is its own row, written when its read succeeds, restored the first time it is fetched, and
independent of the in-memory cache's garbage collection and of `queryClient.clear()` (a Workspace
switch clears memory, not storage). Pin the package version; read its changelog before upgrading,
because the API is experimental.

- `persisted-queries.ts` decides what is kept, and nothing else does. It is an allow-list: a query
  is added only after checking that its data holds nothing volatile or secret (Agent Activity,
  status and presence, an Agent's environment, tokens, upload sessions), that its key names the
  Workspace or conversation it belongs to (a key without one would let another Workspace show
  through), and that its data survives structured cloning. Add a test that names the real query key
  (`query-cache-persistence.test.ts`, "the queries the app really defines").
- What is kept is the first paint, not the whole query: a conversation keeps its newest page, cut
  to what a first read returns (`CONVERSATION_WINDOW_PAGE_SIZE` messages, and thread state only for
  the roots kept; realtime grows the page without bound), and only when that page is the live end;
  the Saved list keeps its newest 100, without the stream positions it was read at (a cut copy is
  not the whole list); a DM list that fell back per call is not kept. Apply the same cut to a new
  kind, so a restore never opens a page at a place nobody meant to open it.
- Nothing is read or written until the person is known (`viewerId`: the Workspace layout loader's
  `user.id`, read from the router's state in `router.tsx`). Every key starts with that person's id,
  the first use by a person removes every other person's rows and records them as the store's
  owner, and every read and write checks that record first: a page whose person no longer owns the
  store (another tab signed out, or in as someone else) seals itself. A store that fails is a
  miss, never a failed read; a read the store does not answer within 250 ms is a miss, and after
  two such reads in a row reads stop waiting on it until it answers anything; writes made meanwhile
  are deferred (newest per query) and written then. A claim records the new owner before it
  removes other people's rows, and overwrites the owner row, never removes it (the same person's
  other tab checks it). The check and the write are separate transactions, so a tab switching
  person in between can still leave one row, removed by the next claim or sign-out.
- Kept data holds no signed URL that expires before the copy does: `storedQueryData` drops every
  `previewUrl` and its WebP tiers (`thumbnailUrl`, `iconUrl`, `largeUrl`; a 30-minute CDN
  signature). Check a new kind for others.
- Every way to `/auth/logout` goes through `signOut()` (`features/auth/sign-out.ts`), which removes
  every row and seals the page against writing more before it navigates. Do not link to
  `/auth/logout` directly.
- A stored copy is only the first paint: the server's read follows at once and replaces it, as
  TanStack's `refetchOnRestore` does
  ([docs](https://tanstack.com/query/latest/docs/framework/react/plugins/createPersister)).
  That option is the persister's, for every kept kind, so `followRestoredReads`
  (`restored-reads.ts`) starts the read instead, for the kinds that have one (`readsAfterRestore`:
  a Computer's Agent workspace scan is a scan of the Computer's disk that only the Scan button
  starts, shown as kept with when it was taken). Until a read of its own lands, the copy stays
  marked invalidated, so any later trigger reads it whatever its `staleTime` (a page mounting it,
  focus, the network returning; the Chat lists use `Infinity`). TanStack clears that mark on any
  success, a write of the page's own included (`setQueryData`: a realtime message, a read position),
  and a read cancelled meanwhile (the last page showing it going away, loading older pages) then
  left the copy as the newest: a channel stayed on its stored window of 10-21 (task #382). So the
  mark is put back whatever cleared it, and loading older or newer pages reads it again.
- A conversation window's read retries online with TanStack's own backoff (3 times; a phone just
  unlocked fails its first reads, task #253), and while offline it is parked until the network
  returns. While the stored copy is on screen and its read failed twice in a row or waits for the
  network (TanStack's `fetchFailureCount`, `paused`), the stream says it could not load the newest
  messages, with a retry (`ConversationUpdateNotice`); the notice goes once the read lands. A
  conversation held in this page's memory says the same when its catch-up
  (`createConversationReconciler`) failed twice in a row, or has not landed while offline.
- Only what a read of the server returned is stored, as TanStack's persister does by itself
  (`setQueryData` is not persisted). What the page writes itself (realtime messages, sends, read
  positions, the sidebar's TanStack DB writes) stays in this page's memory: storing it with a new
  time made an old window look new for good (task #382). The next load opens from the last read
  and reads again. The one write stored by hand is a Computer's Agent workspace scan
  (`storeQueryNow`), which no query read stands behind.
- A conversation window keeps no read cursor of its own: where the viewer's unread starts is read
  on every open (`conversationOpenQuery`, task #378), never kept, so a stored or in-memory window
  paints at once and its age cannot move the "New messages" divider.
- A query the server answers `NOT_FOUND` (deleted, or access lost) is removed from storage.
- `maxAge` is one day, so a copy older than that is not shown (task #382), and a sweep removes
  older rows at most once a day.
- A deploy keeps every stored row: the copy is thrown away only when its shape can no longer be
  read, never because the client changed, so the first Chat open after a deploy still starts from
  it. What decides is `STORED_SHAPE_VERSION` (`persisted-queries.ts`), the persister's `buster`
  ([docs](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient): for
  "changes to your application or data that immediately invalidate any and all cached data"); no
  build id goes into it. Raise it when a row the previous version wrote could no longer be opened as
  it is: a field of a kept kind removed, renamed or retyped, a required field added, or a field's
  meaning or the cut applied to a kind changed. Do not raise it for an optional field or a new kind:
  every raise makes everyone's next Chat open read the network. A shape-only change is caught by
  `test/query-cache-stored-shape.test.ts` (each kind's fixture is typed as its query's real data, so
  a change to the data fails `bun run typecheck` there; following it changes the shape pinned per
  version, which fails the test until the version is raised and the new shape added under it; never
  edit an earlier version's pin). It does not see a change of meaning without a change of shape,
  nor a union member no fixture spells (`senderKind: "system"` is not in any): raise the version by
  hand for those. A new kind adds a fixture and its pin.
- A row that fails `isStoredData` (the list a kind renders from is not a list: the shallow guard
  against a shape the app no longer reads, such as the channel names before they carried a stream
  position) is a miss: the persister removes it on a restore and on the daily sweep, and the
  network read serves. The guard does not replace the version; it never walks a page's messages.
- Browser only. `installBrowserQueryCachePersistence` does nothing where there is no IndexedDB, so
  the server render's per-request QueryClient never sees a persister. Do not put persistence
  options in the QueryClient's `dehydrate` defaults: the SSR integration reads those too.
- `networkMode` stays `online`; a persister would otherwise make every query `offlineFirst`. A kept
  query opened without the network in reach reads `offlineFirst` (the conversation windows,
  `conversationPages`): the restore runs inside the read, which `online` parks before it starts.
  Its read that fails offline is retried at once, which parks it until the network returns
  (TanStack parks only a retry).
- The browser test is `test/e2e-query-cache-persistence.e2e.ts` (opt-in, like the other `*.e2e.ts`:
  local Web at `COFORGE_E2E_WEB_URL` and `agent-browser`; its proxy holds the Chat reads).
