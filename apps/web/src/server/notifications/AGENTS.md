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
