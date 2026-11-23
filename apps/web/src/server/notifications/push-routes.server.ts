import {
  installationRoute,
  notificationRouteFingerprint,
} from "#src/features/notifications/notification-routing";
import type { StoredWebPushSubscription } from "./web-push-notifications.server";

export function deferredPushRoute(subscription: StoredWebPushSubscription) {
  return subscription.browserInstallationId
    ? installationRoute(subscription.browserInstallationId)
    : `subscription:${subscription.id}`;
}

export async function pushDecision(
  messageId: string,
  subscriptions: readonly StoredWebPushSubscription[],
) {
  const pushInstallations = new Set<string>();
  const legacyPush = new Set<string>();
  await Promise.all(
    subscriptions.map(async (subscription) => {
      const id = subscription.browserInstallationId;
      if (id) {
        pushInstallations.add(await notificationRouteFingerprint(messageId, installationRoute(id)));
      } else {
        legacyPush.add(
          await notificationRouteFingerprint(messageId, `endpoint:${subscription.endpoint}`),
        );
      }
    }),
  );
  return { pushInstallations: [...pushInstallations].sort(), legacyPush: [...legacyPush].sort() };
}
