import { effectiveNotificationEvents } from "#src/features/apps/app-notification-events";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaAppNotificationSubscribers } from "#src/server/db/repositories/app-notification-subscribers.repositories.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import type { AppNotificationEvent } from "./app-notification-event";

/** Whether `app-notifications` is on for this Workspace: the one question both recording and
 * fan-out ask first. */
export function appNotificationsEnabled(workspace: { id: string; slug: string }): Promise<boolean> {
  return isFeatureEnabled("app-notifications", {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
  });
}

export type AppNotificationSubscriber = { installationId: string; appId: string };

/**
 * The installations an event is delivered to: those of its Workspace whose app has an enabled
 * webhook and whose effective events include the event's type, while `app-notifications` is on for
 * that Workspace. The effective events are the app's subscribed events the installation approved,
 * whose data groups it also approved and the app still declares (`effectiveNotificationEvents`).
 * Approved groups are read only while `app-data-permissions` is on, so with it off nothing is
 * delivered.
 */
export async function subscribersOf(
  event: AppNotificationEvent,
): Promise<AppNotificationSubscriber[]> {
  const store = new PrismaAppNotificationSubscribers(requireDatabaseClient());
  const workspace = await store.findWorkspace(event.workspaceId);
  if (!workspace || !(await appNotificationsEnabled(workspace))) return [];
  const permissionsOn = await isFeatureEnabled("app-data-permissions", {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
  });
  if (!permissionsOn) return [];
  return (await store.installationsOf(workspace.id))
    .filter((installation) => effectiveNotificationEvents(installation).includes(event.type))
    .map(({ installationId, appId }) => ({ installationId, appId }));
}
