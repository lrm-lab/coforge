# Browser realtime

These rules apply to `src/features/realtime/`.

- The Workspace layout (`w.$workspaceSlug.tsx`) owns one Centrifuge
  connection for the Workspace the page URL names. Feature modules may subscribe to authorized channels but must not
  create additional browser WebSocket connections.
- React consumers subscribe through `useRealtimeSubscription`; imperative conversation readers use `subscribeToSharedRealtime` from `browser-realtime.tsx`. Both use its one ref-counted pool. It
  owns the client type. A page subscribes every channel without a token: Centrifugo asks the
  subscribe proxy (`server/centrifugo/subscribe-proxy.server.ts`) whether its user may hold it,
  and asks again at each refresh, so a lost grant ends the subscription (task #348).
- The connection's state changes, the client's errors and slow token fetches go to the
  console through `connection-journal.ts`, wired once in `BrowserRealtimeProvider`. Centrifugo
  logs only rejected commands, so this is the only record of a connection that never hears back
  (task #322). Keep it free of tokens and message content.
- Subscription hooks must run below `BrowserRealtimeProvider`. Do not call one
  in the component that renders the provider; `useBrowserRealtime` throws there
  so the mistake fails at first render instead of silently never subscribing.
- `useRealtimeSubscription` ref-counts one real `Subscription` per channel per
  client, so several features may share a channel (for example
  `chat:user:<user_id>`). Never call `newSubscription` directly; Centrifuge
  rejects a second subscription to the same channel.
- No handler may throw into the Centrifuge client: it handles every frame on one promise chain,
  and a throw leaves that chain unsettled until the page reloads (task #326). The shared pool runs
  each handler through `dispatch`; a decoder for a shared channel such as `chat:user:` returns
  undefined for what is not its own, binary publications included.
- Presence and join/leave for "who is online" exist only in the `presence`
  Centrifugo namespace; do not enable them on another namespace for that. The
  `daemon` namespace keeps presence (no join/leave) only so the server can
  disconnect one daemon connection; browser code never reads it.
- `runtimeauth:user:<user_id>` carries one person's runtime sign-in progress (authorization link,
  device code, result). Its namespace and `daemon` must never set history
  (`apps/web/test/centrifugo-no-history.test.ts`): a sign-in code or link is not kept after delivery.
- Re-read state a channel may have missed in its `onSubscribed`, as
  `subscriptionGap` (`subscription-gap.ts`) classifies the event, never on
  the client's `connected` event: a channel receives nothing until its own
  subscribe completes, which waits for the subscribe proxy's answer.
- A read that a channel keeps live carries that channel's stream position, read
  on the server before the data and never alongside it
  (`readAfterStreamPositions`; `history` without a limit,
  https://centrifugal.dev/docs/server/history_and_recovery). Compare it with
  `SubscribedRecovery.position` (`streamMovedSince`) instead of re-reading on
  every first subscribe. The shared subscription moves that position with each
  publication it delivers, so a caller joining an already-subscribed channel
  gets where the stream stands for it. Data built from several reads stands at
  the older position of each channel (`olderStreamPositions`); a channel any read
  has no position for, or has in another epoch, has none, and its reader re-reads.
