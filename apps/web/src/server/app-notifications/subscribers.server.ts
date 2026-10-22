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
 * The installations an event is delivered to: those of its Workspace, while `app-notifications`
 * is on for that Workspace. Per-app subscriptions and approved data groups narrow this later; the
 * event worker asks only this.
 */
export async function subscribersOf(
  event: AppNotificationEvent,
): Promise<AppNotificationSubscriber[]> {
  const store = new PrismaAppNotificationSubscribers(requireDatabaseClient());
  const workspace = await store.findWorkspace(event.workspaceId);
  if (!workspace) return [];
  return (await appNotificationsEnabled(workspace)) ? store.installationsOf(workspace.id) : [];
}
