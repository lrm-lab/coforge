# Notifications

These rules apply to `src/server/notifications/`.

- The recipient rule and the notification title, body, and URL are composed
  once on the server (`notificationForMessage`/`notificationForRecipient`,
  sharing one where-clause) and used by both Web Push and in-page
  notifications. The browser only decides whether to show a notification;
  it never recomposes recipients or text.
- `in-page-notification-publisher.server.ts` keeps each recipient's data separate and sends
  ready publications together through Centrifugo's `publishJsonBatch`.
- `web-push-egress.server.ts` only keeps Web Push's names and error messages over
  `server/egress/` (`OutboundEgress`), the one outbound address check shared with app webhooks;
  change the rules there, not here.
- A person's account notification settings (`notification-settings.server.ts`) shape
  both paths through `notification-rules.server.ts`: a pause or quiet hours (in
  `user_preferences.timeZone`) leave them out of push and in-page alike, nothing is sent later; the
  preview and sound shape the payload. Apply them only through those modules, never inline.
- A phone (`deviceKind: "mobile"`) waits while the person uses a computer: the visible, focused CoForge
  page reports its last input (`ACTIVITY_REPORT_MS`; `computer-activity.server.ts`, Redis, `PRESENCE_ONLINE_TTL_MS`), and only
  CoForge input counts. Waiting
  notifications are kept per person (`deferred-mobile-pushes.server.ts`, Redis); the sweep
  (`deferred-mobile-push-sweep.server.ts`, `DEFERRED_MOBILE_PUSH_SWEEP_MS`, in `registerBackgroundSweeps`) looks at a due person with
  their settings and activity only, and once they leave the computer their phones get one unread
  message per conversation (the newest @mention of them, else the newest); read, gone, paused or
  `MAX_DEFER_MS` old ones are dropped. Without `REDIS_URL` every device is sent at once.
- The Settings test goes to every device and is never held back by these settings.
- The realtime `notification.available.v2` decision is per recipient and carries only a message ID,
  Workspace ID, event time, and message-scoped Push fingerprints. Accepted, uncertain and queued
  deliveries leave display to Push. A confirmed rejection permits page fallback. A legacy unbound
  subscription's Push makes fallback unsafe when its installation cannot be identified. New pages
  ignore v1, and open v1 pages regain fallback after refresh. The service worker requests a visible
  notification for every valid Push it receives. Pages use a same-origin IndexedDB transaction to
  claim one display per account and message.
- New deferred pushes use the v3 Redis prefix and snapshot the selected mobile installations (or
  the original subscription for an unbound device). Release intersects that snapshot with currently
  eligible subscriptions, grouping by conversation for each phone. v2 records keep their original
  release rule and drain separately. On rollback, the old reader ignores v3 until a new reader
  returns or the records expire. An unconfirmed queue write stays on the Push path, since Redis may
  have committed it before the response was lost.
