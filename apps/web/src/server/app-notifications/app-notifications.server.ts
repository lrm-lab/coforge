import { fromPrisma } from "pg-boss";

import type { Prisma } from "#src/generated/prisma/client";
import type { AppNotificationEvent } from "./app-notification-event";
import { APP_NOTIFICATION_EVENT_QUEUE } from "./app-notification-jobs";
import { startedAppNotificationQueue } from "./app-notification-queue.server";
import { appNotificationsEnabled } from "./subscribers.server";

/** The `app-notifications` flag is on for the event's Workspace, but the queue is not running in
 * this process, so the event cannot be written. */
export class AppNotificationsUnavailable extends Error {
  constructor() {
    super("app notifications are on but their queue is not started");
    this.name = "AppNotificationsUnavailable";
  }
}

/**
 * The only way domain code emits an app notification. `record` writes the event as a job in the
 * caller's transaction: the event exists if and only if that transaction commits. Recording an
 * event again by its id changes nothing. Delivery to the apps happens later, from the queue.
 * `workspace` is the caller's own Workspace identity, so recording reads nothing but the flag.
 *
 * While `app-notifications` is off for the Workspace, `record` does nothing: it writes no job, so
 * the feature ships dark. While it is on, the queue must already be running (it starts when the server
 * starts, or when the flag file first defines the flag, never inside a domain transaction, because
 * pg-boss creates its schema when it starts; a start still in flight does not count, `record`
 * never waits for it). If it is not, `record` throws `AppNotificationsUnavailable`
 * and the domain transaction rolls back: failing closed beats losing the event silently.
 */
export const AppNotifications = {
  async record(
    tx: Prisma.TransactionClient,
    workspace: { id: string; slug: string },
    event: AppNotificationEvent,
  ): Promise<void> {
    if (!(await appNotificationsEnabled(workspace))) return;
    const boss = startedAppNotificationQueue();
    if (!boss) throw new AppNotificationsUnavailable();
    await boss.send(APP_NOTIFICATION_EVENT_QUEUE, event, { id: event.id, db: fromPrisma(tx) });
  },
};
