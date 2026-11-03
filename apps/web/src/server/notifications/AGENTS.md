# Notifications

These rules apply to `src/server/notifications/`.

- The recipient rule and the notification title, body, and URL are composed
  once on the server (`notificationForMessage`/`notificationForRecipient`,
  sharing one where-clause) and used by both Web Push and in-page
  notifications. The browser only decides whether to show a notification;
  it never recomposes recipients or text.
- `in-page-notification-publisher.server.ts` is only the Centrifugo
  `broadcast` adapter that `WebPushNotifications` publishes through.
- `web-push-egress.server.ts` only keeps Web Push's names and error messages over
  `server/egress/` (`OutboundEgress`), the one outbound address check shared with app webhooks;
  change the rules there, not here.
- A person's account notification settings (`notification-settings.server.ts`, task #467) shape
  both paths through `notification-rules.server.ts`: a pause or quiet hours (in
  `user_preferences.timeZone`) leave them out of push and in-page alike, nothing is sent later; the
  preview and sound shape the payload. Apply them only through those modules, never inline.
- A phone (`deviceKind: "mobile"`) waits while the person uses a computer: the visible, focused CoForge
  page reports its last input every 60 s (`computer-activity.server.ts`, Redis, 150 s), and only
  CoForge input counts. Waiting
  notifications are kept per person (`deferred-mobile-pushes.server.ts`, Redis); the 15 s sweep
  (`deferred-mobile-push-sweep.server.ts`, in `registerBackgroundSweeps`) looks at a due person with
  their settings and activity only, and once they leave the computer their phones get the newest
  unread message of each conversation; read, gone, paused or 12 h old ones are dropped. Without
  `REDIS_URL` every device is sent at once.
- The Settings test goes to every device and is never held back by these settings.
